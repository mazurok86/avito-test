import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Page } from 'puppeteer';

import { AppConfigService } from '../../config/config.service';
import { BrowserService } from './browser.service';
import type { AuthState, StatusChange } from './avito.types';

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
        await page.goto(AVITO_PROFILE_URL, {
          waitUntil: 'domcontentloaded',
          timeout: TIMEOUTS_MS.pageNavigation,
        });
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

    // networkidle2 (vs. domcontentloaded) waits for the SPA to actually
    // hydrate — bundles fetched, login-modal JS executed, XHRs settled.
    // Otherwise the next waitForSelector(loginForm) ends up doing all the
    // waiting itself.
    this.logger.log(`Navigating to login page (${AVITO_LOGIN_URL}, waitUntil=networkidle2)`);
    await page.goto(AVITO_LOGIN_URL, {
      waitUntil: 'networkidle2',
      timeout: TIMEOUTS_MS.pageNavigation,
    });
    this.logger.log('Login page hydrated, waiting for login form…');

    await this.waitForSelectorAny(page, SELECTORS.loginForm, TIMEOUTS_MS.loginFormAppear);
    this.logger.log('Login form visible, filling login input');
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
    this.logger.log(`Landing on messenger (${AVITO_PROFILE_URL})`);
    await page
      .goto(AVITO_PROFILE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUTS_MS.pageNavigation,
      })
      .catch(() => undefined);
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
