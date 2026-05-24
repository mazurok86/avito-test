import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Frame, Page, WaitForOptions } from 'puppeteer';

import { BrowserService } from './browser.service';
import { PageDebugService } from './page-debug.service';
import type { AuthState, StatusChange } from './avito.types';

// Avito serves a "доступ ограничен" interstitial when rate-limiting or
// IP-blocking. We surface this as a typed error so callers (and logs) can
// distinguish "Avito turned us away" from generic timeout/DOM failures.
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
  /** How long the service waits for the user to deliver login + password via POST /auth/credentials. */
  credentialsWait: 5 * 60000,
};

// Login is rendered as a modal on top of the home page (#login hash).
const SELECTORS = {
  loginForm: 'form[data-marker="login-form"]',
  loginInput: 'form[data-marker="login-form"] input[data-marker="login-form/login/input"]',
  passwordInput: 'form[data-marker="login-form"] input[data-marker="login-form/password/input"]',
  submitButton: 'form[data-marker="login-form"] button[data-marker="login-form/submit"]',
  codeInput:
    '[data-marker="code-form/code/input"], [data-marker="code/input"], input[name="code"], input[name="codeConfirm"], input[autocomplete="one-time-code"]',
  // Avito sometimes shows a "saved users" picker instead of the regular login
  // form when the browser has remembered an account. Picking a user takes us
  // to the avatar variant of the login form (password-only; login pre-filled).
  usersList: '[data-marker="users-list"]',
  usersListFirstUser: '[data-marker="users-list"] [data-marker="user/link"]',
  // Profile menu in the site header. Present on any Avito page only when a
  // user session is active — independent of which path we landed on, so
  // it's a clean session indicator.
  headerMenuProfile: '[data-marker="header/menu-profile"]',
};

type CodeResolver = (code: string) => void;
type CredentialsResolver = (creds: { login: string; password: string }) => void;
type TimeoutHandle = ReturnType<typeof setTimeout>;

@Injectable()
export class AvitoAuthService {
  private readonly logger = new Logger(AvitoAuthService.name);
  private pendingCodeResolver: CodeResolver | null = null;
  private pendingCodeTimeout: TimeoutHandle | null = null;
  private pendingCredentialsResolver: CredentialsResolver | null = null;
  private pendingCredentialsTimeout: TimeoutHandle | null = null;

  constructor(
    private readonly browser: BrowserService,
    private readonly events: EventEmitter2,
    private readonly pageDebug: PageDebugService,
  ) {}

  /**
   * Resolves with a Page that is authorized in Avito. Single attempt — any
   * failure (timeouts, blocked access, post-login probe fails) throws and
   * leaves the watcher in `error` state. Restart the service to retry.
   */
  async ensureAuthorized(): Promise<Page> {
    this.logger.log(`Auth flow started (target: ${AVITO_PROFILE_URL})`);
    this.setState('starting');
    let page = await this.browser.newPage();

    this.logger.log('Probing session…');
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
    await this.pageDebug.captureDebug(page, `session-probe-${authorized ? 'authorized' : 'anon'}`);
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

    this.setState('logging_in', 'Performing login');
    await this.performLogin(page);

    this.logger.log('Re-probing session after login…');
    const authorizedAfterLogin = await this.isAuthorized(page);
    this.logger.log(
      `Post-login probe: ${authorizedAfterLogin ? 'header/menu-profile found → authorized' : 'header/menu-profile missing'}`,
    );
    await this.pageDebug.captureDebug(
      page,
      `post-login-probe-${authorizedAfterLogin ? 'authorized' : 'anon'}`,
    );
    if (!authorizedAfterLogin) {
      throw new Error(
        'Authorization failed: post-login session probe did not find header/menu-profile',
      );
    }
    this.setState('authorized', 'Logged in');
    return page;
  }

  /**
   * Drop any in-flight code/credentials requests. Called when the watcher
   * restarts after an error — without this, a stale setTimeout from the
   * previous attempt can fire mid-restart and silently null out the new
   * attempt's pending resolver (because both write to the same field), so
   * the new attempt's request would hang until its own timeout.
   */
  resetPendingRequests(): void {
    if (this.pendingCodeTimeout) {
      clearTimeout(this.pendingCodeTimeout);
      this.pendingCodeTimeout = null;
    }
    if (this.pendingCredentialsTimeout) {
      clearTimeout(this.pendingCredentialsTimeout);
      this.pendingCredentialsTimeout = null;
    }
    this.pendingCodeResolver = null;
    this.pendingCredentialsResolver = null;
  }

  /** Called by REST endpoint when the user submits a 2FA code. */
  submitCode(code: string): boolean {
    if (!this.pendingCodeResolver) return false;
    const resolver = this.pendingCodeResolver;
    this.pendingCodeResolver = null;
    if (this.pendingCodeTimeout) {
      clearTimeout(this.pendingCodeTimeout);
      this.pendingCodeTimeout = null;
    }
    resolver(code);
    return true;
  }

  isAwaitingCode(): boolean {
    return this.pendingCodeResolver !== null;
  }

  /** Called by REST endpoint when the user submits Avito login + password. */
  submitCredentials(login: string, password: string): boolean {
    if (!this.pendingCredentialsResolver) return false;
    const resolver = this.pendingCredentialsResolver;
    this.pendingCredentialsResolver = null;
    if (this.pendingCredentialsTimeout) {
      clearTimeout(this.pendingCredentialsTimeout);
      this.pendingCredentialsTimeout = null;
    }
    resolver({ login, password });
    return true;
  }

  isAwaitingCredentials(): boolean {
    return this.pendingCredentialsResolver !== null;
  }

  private async performLogin(page: Page): Promise<void> {
    // 'load' (vs. domcontentloaded) waits for all blocking subresources —
    // bundles, CSS, async scripts — so the login modal has its JS available
    // by the time we start hunting for the form selector.
    await this.gotoWithChain(
      page,
      AVITO_LOGIN_URL,
      { waitUntil: 'load', timeout: TIMEOUTS_MS.pageNavigation },
      'login-page',
    );
    this.logger.log('Login page hydrated, waiting for login form or saved users picker…');
    await this.pageDebug.captureDebug(page, 'after-login-page-load');

    const variant = await this.waitForLoginVariant(page);
    this.logger.log(`Login variant: ${variant}`);

    if (variant === 'users-list') {
      await this.pageDebug.captureDebug(page, 'users-list-detected');
      this.logger.log('Saved users picker shown — clicking saved account');
      const userLink = await this.waitForSelectorAny(
        page,
        SELECTORS.usersListFirstUser,
        TIMEOUTS_MS.inputAppear,
      );
      await userLink.click();
      await this.pageDebug.captureDebug(page, 'after-user-click');

      this.logger.log('Waiting for avatar login form to mount…');
      try {
        await this.waitForSelectorAny(page, SELECTORS.loginForm, TIMEOUTS_MS.loginFormAppear);
      } catch (err) {
        await this.pageDebug.captureDebug(page, 'avatar-form-timeout');
        throw err;
      }
    }

    // Form is on screen. Run two things concurrently:
    //   * the mandatory settle delay (Avito's SPA re-renders the form right
    //     after mount; typing before this finishes causes handle races);
    //   * the credentials request to the user via WS + REST.
    // Whichever finishes last gates the typing step. In practice the user
    // takes much longer than the settle, so the settle is "free".
    this.logger.log(
      `Login form visible — settling ${TIMEOUTS_MS.loginFormSettle}ms and asking user for credentials in parallel`,
    );
    const settlePromise = this.sleep(TIMEOUTS_MS.loginFormSettle);
    this.setState('awaiting_credentials', 'Введите Avito-логин и пароль на странице');
    const credentialsPromise = this.requestCredentialsFromUser(
      'Avito requires login + password',
    );
    const [{ login, password }] = await Promise.all([credentialsPromise, settlePromise]);
    this.setState('logging_in', 'Credentials received, submitting');
    await this.pageDebug.captureDebug(page, 'after-settle');

    // Avatar variant pre-fills the login as a hidden input — no visible login
    // field. Detect by querying SELECTORS.loginInput; absence == avatar variant.
    // (The login the user typed in the UI is silently discarded in that case;
    // Avito has already locked the account-selector to one user.)
    const loginInputHandle = await page.$(SELECTORS.loginInput);
    if (loginInputHandle) {
      this.logger.log('Filling login input');
      await loginInputHandle.click({ clickCount: 3 });
      await loginInputHandle.type(login, { delay: TIMEOUTS_MS.typingKeystroke });
      await loginInputHandle.dispose();
      await this.pageDebug.captureDebug(page, 'login-filled');
    } else {
      this.logger.log('Avatar login form (login pre-filled) — skipping login input');
    }

    this.logger.log('Filling password input');
    const passwordInput = await this.waitForSelectorAny(
      page,
      SELECTORS.passwordInput,
      TIMEOUTS_MS.inputAppear,
    );
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(password, { delay: TIMEOUTS_MS.typingKeystroke });
    await this.pageDebug.captureDebug(page, 'password-filled');

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
    await this.pageDebug.captureDebug(page, 'after-credentials-submit');

    const outcome = await Promise.race([navPromise, codePromise]);
    if (outcome === null) {
      await this.pageDebug.captureDebug(page, 'login-outcome-timeout');
      throw new Error('Login did not complete within 60s: neither redirect nor 2FA prompt');
    }
    this.logger.log(
      outcome === 'redirected'
        ? 'Login outcome: navigation → credentials accepted, no 2FA'
        : 'Login outcome: 2FA prompt rendered',
    );
    await this.pageDebug.captureDebug(page, `login-outcome-${outcome === 'redirected' ? 'redirected' : '2fa'}`);

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
      await this.pageDebug.captureDebug(page, 'code-filled');

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
      await this.pageDebug.captureDebug(page, 'after-code-submit');

      if (!(await navAfterCode)) {
        await this.pageDebug.captureDebug(page, 'post-2fa-timeout');
        throw new Error('2FA did not complete within 60s: no redirect after code submit');
      }
      this.logger.log('2FA navigation landed — Avito accepted the code');
      await this.pageDebug.captureDebug(page, 'post-2fa-success');
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
   * After landing on the login page Avito renders one of:
   *   - the regular login form (`form[data-marker="login-form"]`);
   *   - a saved-users picker (`[data-marker="users-list"]`) when the browser
   *     has remembered an account on this profile.
   * Race both and return whichever appears first.
   */
  private async waitForLoginVariant(page: Page): Promise<'login-form' | 'users-list'> {
    try {
      return await Promise.any([
        page
          .waitForSelector(SELECTORS.loginForm, { timeout: TIMEOUTS_MS.loginFormAppear })
          .then(() => 'login-form' as const),
        page
          .waitForSelector(SELECTORS.usersList, { timeout: TIMEOUTS_MS.loginFormAppear })
          .then(() => 'users-list' as const),
      ]);
    } catch {
      await this.pageDebug.captureDebug(page, 'login-form-timeout');
      throw new Error('Neither login form nor saved users picker appeared');
    }
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
        await this.pageDebug.captureDebug(page, `${label}-blocked`);
        throw new AvitoAccessBlockedError(`title="${title}", url=${finalUrl}`);
      }
    } finally {
      page.off('framenavigated', onNav);
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
      this.pendingCodeTimeout = setTimeout(() => {
        this.pendingCodeResolver = null;
        this.pendingCodeTimeout = null;
        reject(
          new Error(`2FA code timeout (${TIMEOUTS_MS.twoFactorCodeWait / 60000} min)`),
        );
      }, TIMEOUTS_MS.twoFactorCodeWait);

      this.pendingCodeResolver = (code: string) => {
        if (this.pendingCodeTimeout) {
          clearTimeout(this.pendingCodeTimeout);
          this.pendingCodeTimeout = null;
        }
        resolve(code);
      };

      this.events.emit('auth.needs_code', { reason, at: new Date().toISOString() });
    });
  }

  private requestCredentialsFromUser(
    reason: string,
  ): Promise<{ login: string; password: string }> {
    return new Promise<{ login: string; password: string }>((resolve, reject) => {
      this.pendingCredentialsTimeout = setTimeout(() => {
        this.pendingCredentialsResolver = null;
        this.pendingCredentialsTimeout = null;
        reject(
          new Error(`Credentials timeout (${TIMEOUTS_MS.credentialsWait / 60000} min)`),
        );
      }, TIMEOUTS_MS.credentialsWait);

      this.pendingCredentialsResolver = (creds) => {
        if (this.pendingCredentialsTimeout) {
          clearTimeout(this.pendingCredentialsTimeout);
          this.pendingCredentialsTimeout = null;
        }
        resolve(creds);
      };

      this.events.emit('auth.needs_credentials', { reason, at: new Date().toISOString() });
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
