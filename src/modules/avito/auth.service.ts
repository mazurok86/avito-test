import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Frame, Page, WaitForOptions } from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AppConfigService } from '../../config/config.service';
import { BrowserService } from './browser.service';
import type { AuthState, StatusChange } from './avito.types';

const DEBUG_DIR = './debug-screenshots';

// Avito serves a "доступ ограничен" interstitial when rate-limiting or
// IP-blocking — retrying the same flow won't unblock us, so we surface this
// as a typed error and bail out of the retry loop.
const BLOCKED_TITLE_MARKER = 'Доступ ограничен';

class AvitoAccessBlockedError extends Error {
  constructor(detail: string) {
    super(`Avito access blocked: ${detail}`);
    this.name = 'AvitoAccessBlockedError';
  }
}

const AVITO_PROFILE_URL = 'https://www.avito.ru/profile/messenger';
const AVITO_LOGIN_URL = 'https://www.avito.ru/#login';

// All wait windows and fixed delays in the auth flow, in milliseconds.
// Tunable from one place so the intent of each timer is named.
const TIMEOUTS_MS = {
  /** Max wait for any page.goto() during the auth flow. */
  pageNavigation: 180000,
  /** Max wait for the login modal to mount after navigating to AVITO_LOGIN_URL. */
  loginFormAppear: 60000,
  /** Max wait for input fields (login/password/code) once the form is on screen. */
  inputAppear: 5000,
  /** Per-keystroke delay during type() — mimics human input. */
  typingKeystroke: 40,
  /** Settle pause after the login form first appears, before we start typing.
   *  Avito's SPA can keep re-rendering the form right after it mounts; touching
   *  inputs too early causes handle/document races. */
  loginFormSettle: 10000,
  /** Race window after credentials submit: "redirect happened" vs "2FA prompt rendered". */
  loginOutcome: 60000,
  /** Wait for the post-2FA-submit redirect to land. */
  twoFactorRedirect: 60000,
  /** How long the service waits for the user to deliver a 2FA code via POST /auth/code. */
  twoFactorCodeWait: 5 * 60000,
  /** Base for linear backoff between retries (multiplied by attempt number). */
  retryBackoffBase: 2000,
};

// Login is rendered as a modal on top of the home page (#login hash).
const SELECTORS = {
  loginForm: 'form[data-marker="login-form"]',
  loginInput: 'form[data-marker="login-form"] input[data-marker="login-form/login/input"]',
  passwordInput: 'form[data-marker="login-form"] input[data-marker="login-form/password/input"]',
  submitButton: 'form[data-marker="login-form"] button[data-marker="login-form/submit"]',
  codeInput:
    '[data-marker="code-form/code/input"], [data-marker="code/input"], input[name="code"], input[name="codeConfirm"], input[autocomplete="one-time-code"]',
  // Profile menu in the site header. Present on any Avito page only when a
  // user session is active — independent of which path we landed on, so
  // it's a clean session indicator.
  headerMenuProfile: '[data-marker="header/menu-profile"]',
};

type CodeResolver = (code: string) => void;

@Injectable()
export class AvitoAuthService {
  private readonly logger = new Logger(AvitoAuthService.name);
  private pendingCodeResolver: CodeResolver | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly browser: BrowserService,
    private readonly events: EventEmitter2,
  ) {}

  /** Resolves with a Page that is authorized in Avito. Throws on permanent failure. */
  async ensureAuthorized(): Promise<Page> {
    this.logger.log(
      `Auth flow started (max attempts: ${this.config.authMaxAttempts}, target: ${AVITO_PROFILE_URL})`,
    );
    this.setState('starting');
    let page = await this.browser.newPage();

    let attempt = 0;
    let lastError: string | null = null;
    while (attempt < this.config.authMaxAttempts) {
      attempt += 1;
      try {
        this.logger.log(`Attempt ${attempt}/${this.config.authMaxAttempts}: probing session…`);
        await this.gotoWithChain(
          page,
          AVITO_PROFILE_URL,
          { waitUntil: 'domcontentloaded', timeout: TIMEOUTS_MS.pageNavigation },
          'session-probe',
        );
        const authorized = await this.isAuthorized(page);
        this.logger.log(
          `Session probe: ${authorized ? 'header/menu-profile found → authorized' : 'header/menu-profile missing → need login'}`,
        );
        if (authorized) {
          this.setState('authorized', 'Session restored');
          return page;
        }

        // Discard the probe page — it may have an in-flight Avito redirect
        // and stale SPA state. Login flow gets a brand-new tab; cookies and
        // session live on the browser context (userDataDir), not the page.
        this.logger.log('Discarding probe tab, opening fresh tab for login');
        await page.close().catch(() => undefined);
        page = await this.browser.newPage();

        this.setState('logging_in', `Attempt ${attempt}/${this.config.authMaxAttempts}`);
        await this.performLogin(page);

        this.logger.log('Re-probing session after login…');
        const authorizedAfterLogin = await this.isAuthorized(page);
        this.logger.log(
          `Post-login probe: ${authorizedAfterLogin ? 'header/menu-profile found → authorized' : 'header/menu-profile missing → will retry'}`,
        );
        if (authorizedAfterLogin) {
          this.setState('authorized', 'Logged in');
          return page;
        }
      } catch (err) {
        // Don't emit error here — it'd flicker between retries and mislead
        // clients. The final state is set by the caller via the throw below.
        lastError = (err as Error).message;
        this.logger.warn(`Login attempt ${attempt} failed: ${lastError}`);

        // Avito-side block (rate-limit / IP-ban) — retrying the same flow
        // from the same IP won't unblock us. Bail out immediately so the
        // operator sees the real cause instead of waiting through all retries.
        if (err instanceof AvitoAccessBlockedError) {
          this.logger.error('Aborting retry loop: Avito blocked access');
          throw err;
        }

        const backoff = TIMEOUTS_MS.retryBackoffBase * attempt;
        this.logger.log(`Backing off ${backoff}ms before next attempt`);
        await this.sleep(backoff);
      }
    }

    throw new Error(
      lastError
        ? `Failed to authorize on Avito after ${this.config.authMaxAttempts} attempts: ${lastError}`
        : `Failed to authorize on Avito after ${this.config.authMaxAttempts} attempts`,
    );
  }

  /** Called by REST endpoint when the user submits a 2FA code. */
  submitCode(code: string): boolean {
    if (!this.pendingCodeResolver) return false;
    const resolver = this.pendingCodeResolver;
    this.pendingCodeResolver = null;
    resolver(code);
    return true;
  }

  isAwaitingCode(): boolean {
    return this.pendingCodeResolver !== null;
  }

  private async performLogin(page: Page): Promise<void> {
    if (!this.config.avitoLogin || !this.config.avitoPassword) {
      throw new Error('AVITO_LOGIN/AVITO_PASSWORD are not set');
    }

    // 'load' (vs. domcontentloaded) waits for all blocking subresources —
    // bundles, CSS, async scripts — so the login modal has its JS available
    // by the time we start hunting for the form selector.
    await this.gotoWithChain(
      page,
      AVITO_LOGIN_URL,
      { waitUntil: 'load', timeout: TIMEOUTS_MS.pageNavigation },
      'login-page',
    );
    this.logger.log('Login page hydrated, waiting for login form…');
    await this.captureDebug(page, 'after-login-page-load');

    try {
      await this.waitForSelectorAny(page, SELECTORS.loginForm, TIMEOUTS_MS.loginFormAppear);
    } catch (err) {
      await this.captureDebug(page, 'login-form-timeout');
      throw err;
    }
    this.logger.log(
      `Login form visible — settling ${TIMEOUTS_MS.loginFormSettle}ms before filling inputs`,
    );
    await this.sleep(TIMEOUTS_MS.loginFormSettle);
    await this.captureDebug(page, 'after-settle');
    this.logger.log('Filling login input');
    const loginInput = await this.waitForSelectorAny(
      page,
      SELECTORS.loginInput,
      TIMEOUTS_MS.inputAppear,
    );
    await loginInput.click({ clickCount: 3 });
    await loginInput.type(this.config.avitoLogin, { delay: TIMEOUTS_MS.typingKeystroke });

    this.logger.log('Filling password input');
    const passwordInput = await this.waitForSelectorAny(
      page,
      SELECTORS.passwordInput,
      TIMEOUTS_MS.inputAppear,
    );
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(this.config.avitoPassword, { delay: TIMEOUTS_MS.typingKeystroke });

    // Race two events for the next 60s — register BOTH before clicking submit,
    // otherwise an immediate redirect can fire before we attach the listener.
    //   - waitForNavigation resolves on any real cross-document nav  → success;
    //   - waitForSelector(codeInput) resolves when the 2FA modal renders;
    //   - if neither fires in 60s, both reject → outcome is null → fail.
    const navPromise = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUTS_MS.loginOutcome })
      .then(() => 'redirected' as const)
      .catch(() => null);
    const codePromise = page
      .waitForSelector(SELECTORS.codeInput, { timeout: TIMEOUTS_MS.loginOutcome })
      .then(() => '2fa' as const)
      .catch(() => null);

    this.logger.log('Submitting credentials, racing navigation vs 2FA prompt…');
    await this.tryClickSubmit(page);

    const outcome = await Promise.race([navPromise, codePromise]);
    if (outcome === null) {
      throw new Error('Login did not complete within 60s: neither redirect nor 2FA prompt');
    }
    this.logger.log(
      outcome === 'redirected'
        ? 'Login outcome: navigation → credentials accepted, no 2FA'
        : 'Login outcome: 2FA prompt rendered',
    );

    if (outcome === '2fa') {
      this.logger.log('Emitting auth.needs_code, awaiting POST /auth/code from frontend');
      this.setState('awaiting_code', 'Avito requested 2FA code');

      const code = await this.requestCodeFromUser('SMS or app code requested by Avito');
      this.logger.log('2FA code received from frontend, filling input');
      const codeInput = await this.waitForSelectorAny(
        page,
        SELECTORS.codeInput,
        TIMEOUTS_MS.inputAppear,
      );
      await codeInput.click({ clickCount: 3 });
      await codeInput.type(code, { delay: TIMEOUTS_MS.typingKeystroke });

      // Only success criterion after 2FA submit is a real navigation. Same
      // registration-before-click rule as above.
      const navAfterCode = page
        .waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: TIMEOUTS_MS.twoFactorRedirect,
        })
        .then(() => true)
        .catch(() => false);

      this.logger.log('Submitting 2FA code, waiting for navigation…');
      await this.tryClickSubmit(page);

      if (!(await navAfterCode)) {
        throw new Error('2FA did not complete within 60s: no redirect after code submit');
      }
      this.logger.log('2FA navigation landed — Avito accepted the code');
      // Real confirmation that Avito accepted the code, not just the user
      // submitting it to us. Emit only after the post-2FA navigation lands.
      this.events.emit('auth.code_accepted');
    }

    // Land on the messenger so the watcher has the right page to observe.
    await this.gotoWithChain(
      page,
      AVITO_PROFILE_URL,
      { waitUntil: 'domcontentloaded', timeout: TIMEOUTS_MS.pageNavigation },
      'messenger-landing',
    ).catch((err) => {
      this.logger.warn(`Final landing navigation failed: ${(err as Error).message}`);
    });
  }

  private async tryClickSubmit(page: Page): Promise<void> {
    const btn = await page.$(SELECTORS.submitButton);
    if (btn) {
      await btn.click().catch(() => undefined);
    } else {
      await page.keyboard.press('Enter').catch(() => undefined);
    }
  }

  private async waitForSelectorAny(page: Page, selector: string, timeout: number) {
    const handle = await page.waitForSelector(selector, { timeout });
    if (!handle) throw new Error(`Selector not found: ${selector}`);
    return handle;
  }

  /**
   * Wraps page.goto with full visibility into the navigation:
   *   - HTTP redirect chain via response.request().redirectChain() (server-side 3xx);
   *   - main-frame navigations during the goto window (client-side location.replace,
   *     history.pushState, hash routes — anything that doesn't show as HTTP redirect);
   *   - final landing URL.
   * Returns whatever page.goto would return.
   */
  private async gotoWithChain(
    page: Page,
    url: string,
    opts: WaitForOptions & { timeout?: number },
    label: string,
  ): Promise<void> {
    const frameNavs: string[] = [];
    const mainFrame = page.mainFrame();
    const onNav = (frame: Frame): void => {
      if (frame === mainFrame) frameNavs.push(frame.url());
    };
    page.on('framenavigated', onNav);

    try {
      this.logger.log(`[nav:${label}] target = ${url}`);
      const response = await page.goto(url, opts);

      const httpChain = response
        ? [...response.request().redirectChain().map((r) => r.url()), response.url()]
        : [];

      if (httpChain.length > 1) {
        this.logger.log(`[nav:${label}] HTTP redirect chain (${httpChain.length} hops):`);
        httpChain.forEach((u, i) => this.logger.log(`[nav:${label}]   [${i}] ${u}`));
      } else if (httpChain.length === 1) {
        this.logger.log(`[nav:${label}] no HTTP redirects (200 from ${httpChain[0]})`);
      } else {
        this.logger.log(`[nav:${label}] no HTTP response (likely same-document nav)`);
      }

      if (frameNavs.length > 0) {
        this.logger.log(`[nav:${label}] main-frame navigations during goto (${frameNavs.length}):`);
        frameNavs.forEach((u, i) => this.logger.log(`[nav:${label}]   [${i}] ${u}`));
      }

      const finalUrl = page.url();
      const title = await page.title().catch(() => '');
      this.logger.log(`[nav:${label}] final URL = ${finalUrl}`);
      this.logger.log(`[nav:${label}] page title = "${title}"`);

      if (title.includes(BLOCKED_TITLE_MARKER)) {
        await this.captureDebug(page, `${label}-blocked`);
        throw new AvitoAccessBlockedError(`title="${title}", url=${finalUrl}`);
      }
    } finally {
      page.off('framenavigated', onNav);
    }
  }

  /**
   * Dumps a full-page screenshot + HTML snapshot + current URL/title for
   * post-mortem debugging. Files go into ./debug-screenshots/<ts>-<label>.{png,html}.
   * Safe to call on any page state — all errors are swallowed.
   */
  private async captureDebug(page: Page, label: string): Promise<void> {
    try {
      await mkdir(resolve(DEBUG_DIR), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeLabel = label.replace(/[^a-z0-9-]+/gi, '_');
      const base = resolve(DEBUG_DIR, `${stamp}-${safeLabel}`);

      const url = page.url();
      const title = await page.title().catch(() => '<title unavailable>');
      this.logger.log(`[DEBUG] capture "${label}": url=${url} title=${title}`);

      await page.screenshot({ path: `${base}.png` as `${string}.png`, fullPage: true });
      const html = await page.content();
      await writeFile(`${base}.html`, html, 'utf8');
      this.logger.log(`[DEBUG] capture "${label}" → ${base}.{png,html}`);
    } catch (err) {
      this.logger.warn(`[DEBUG] capture "${label}" failed: ${(err as Error).message}`);
    }
  }

  private async isAuthorized(page: Page): Promise<boolean> {
    // header/menu-profile is rendered on any Avito page that has an active
    // session. Querying via page.evaluate returns a primitive boolean — no
    // ElementHandle, no DOM.resolveNode races during in-flight navigation.
    return page
      .evaluate(
        (sel: string) => document.querySelector(sel) !== null,
        SELECTORS.headerMenuProfile,
      )
      .catch(() => false);
  }

  private requestCodeFromUser(reason: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCodeResolver = null;
        reject(
          new Error(`2FA code timeout (${TIMEOUTS_MS.twoFactorCodeWait / 60000} min)`),
        );
      }, TIMEOUTS_MS.twoFactorCodeWait);

      this.pendingCodeResolver = (code: string) => {
        clearTimeout(timeout);
        resolve(code);
      };

      this.events.emit('auth.needs_code', { reason, at: new Date().toISOString() });
    });
  }

  private setState(state: AuthState, detail?: string): void {
    const payload: StatusChange = { state, detail, at: new Date().toISOString() };
    this.logger.log(`Auth state → ${state}${detail ? ` (${detail})` : ''}`);
    this.events.emit('status.change', payload);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
