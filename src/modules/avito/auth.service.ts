import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Page } from 'puppeteer';

import { AppConfigService } from '../../config/config.service';
import { BrowserService } from './browser.service';
import type { AuthState, StatusChange } from './avito.types';

const AVITO_PROFILE_URL = 'https://www.avito.ru/profile/messenger';
const AVITO_LOGIN_URL = 'https://www.avito.ru/#login';

// Login is rendered as a modal on top of the home page (#login hash).
const SELECTORS = {
  loginForm: 'form[data-marker="login-form"]',
  loginInput: 'form[data-marker="login-form"] input[data-marker="login-form/login/input"]',
  passwordInput: 'form[data-marker="login-form"] input[data-marker="login-form/password/input"]',
  submitButton: 'form[data-marker="login-form"] button[data-marker="login-form/submit"]',
  codeInput:
    '[data-marker="code-form/code/input"], [data-marker="code/input"], input[name="code"], input[name="codeConfirm"], input[autocomplete="one-time-code"]',
  // Coupled with ChatWatcherService.CHANNELS_LIST_SELECTOR. Used as the
  // positive signal that we're on the messenger AND logged in.
  channelsList: '[data-marker="channels/list"]',
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
    this.setState('starting');
    let page = await this.browser.newPage();

    let attempt = 0;
    let lastError: string | null = null;
    while (attempt < this.config.authMaxAttempts) {
      attempt += 1;
      try {
        await page.goto(AVITO_PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (await this.isAuthorized(page)) {
          this.setState('authorized', 'Session restored');
          return page;
        }

        // Discard the probe page — it may have an in-flight Avito redirect
        // and stale SPA state. Login flow gets a brand-new tab; cookies and
        // session live on the browser context (userDataDir), not the page.
        await page.close().catch(() => undefined);
        page = await this.browser.newPage();

        this.setState('logging_in', `Attempt ${attempt}/${this.config.authMaxAttempts}`);
        await this.performLogin(page);

        if (await this.isAuthorized(page)) {
          this.setState('authorized', 'Logged in');
          return page;
        }
      } catch (err) {
        // Don't emit error here — it'd flicker between retries and mislead
        // clients. The final state is set by the caller via the throw below.
        lastError = (err as Error).message;
        this.logger.warn(`Login attempt ${attempt} failed: ${lastError}`);
        await this.sleep(2000 * attempt);
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

    await page.goto(AVITO_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await this.waitForSelectorAny(page, SELECTORS.loginForm, 20000);
    const loginInput = await this.waitForSelectorAny(page, SELECTORS.loginInput, 5000);
    await loginInput.click({ clickCount: 3 });
    await loginInput.type(this.config.avitoLogin, { delay: 40 });

    const passwordInput = await this.waitForSelectorAny(page, SELECTORS.passwordInput, 5000);
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(this.config.avitoPassword, { delay: 40 });

    // Race two events for the next 60s — register BOTH before clicking submit,
    // otherwise an immediate redirect can fire before we attach the listener.
    //   - waitForNavigation resolves on any real cross-document nav  → success;
    //   - waitForSelector(codeInput) resolves when the 2FA modal renders;
    //   - if neither fires in 60s, both reject → outcome is null → fail.
    const navPromise = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 })
      .then(() => 'redirected' as const)
      .catch(() => null);
    const codePromise = page
      .waitForSelector(SELECTORS.codeInput, { timeout: 60000 })
      .then(() => '2fa' as const)
      .catch(() => null);

    await this.tryClickSubmit(page);

    const outcome = await Promise.race([navPromise, codePromise]);
    if (outcome === null) {
      throw new Error('Login did not complete within 60s: neither redirect nor 2FA prompt');
    }

    if (outcome === '2fa') {
      this.logger.log('2FA prompt detected — awaiting code from frontend');
      this.setState('awaiting_code', 'Avito requested 2FA code');

      const code = await this.requestCodeFromUser('SMS or app code requested by Avito');
      const codeInput = await this.waitForSelectorAny(page, SELECTORS.codeInput, 5000);
      await codeInput.click({ clickCount: 3 });
      await codeInput.type(code, { delay: 40 });

      // Only success criterion after 2FA submit is a real navigation. Same
      // registration-before-click rule as above.
      const navAfterCode = page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 })
        .then(() => true)
        .catch(() => false);

      await this.tryClickSubmit(page);

      if (!(await navAfterCode)) {
        throw new Error('2FA did not complete within 60s: no redirect after code submit');
      }
      // Real confirmation that Avito accepted the code, not just the user
      // submitting it to us. Emit only after the post-2FA navigation lands.
      this.events.emit('auth.code_accepted');
    }

    // Land on the messenger so the watcher has the right page to observe.
    await page
      .goto(AVITO_PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
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
    return page
      .evaluate((sel: string) => document.querySelector(sel) !== null, SELECTORS.channelsList)
      .catch(() => false);
  }

  private requestCodeFromUser(reason: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pendingCodeResolver = null;
          reject(new Error('2FA code timeout (5 min)'));
        },
        5 * 60 * 1000,
      );

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
