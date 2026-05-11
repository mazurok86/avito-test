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
    const page = await this.browser.newPage();

    let attempt = 0;
    while (attempt < this.config.authMaxAttempts) {
      attempt += 1;
      try {
        await page.goto(AVITO_PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (await this.isAuthorized(page)) {
          this.setState('authorized', 'Session restored');
          return page;
        }

        this.setState('logging_in', `Attempt ${attempt}/${this.config.authMaxAttempts}`);
        await this.performLogin(page);

        if (await this.isAuthorized(page)) {
          this.setState('authorized', 'Logged in');
          return page;
        }
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn(`Login attempt ${attempt} failed: ${msg}`);
        this.setState('error', msg);
        await this.sleep(2000 * attempt);
      }
    }

    throw new Error('Failed to authorize on Avito after max attempts');
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
    // Hash-routed modal isn't always shown on cold load — re-trigger via location.hash.
    await page.evaluate(() => {
      if (location.hash !== '#login') location.hash = 'login';
    });

    await this.waitForSelectorAny(page, SELECTORS.loginForm, 20000);
    const loginInput = await this.waitForSelectorAny(page, SELECTORS.loginInput, 5000);
    await loginInput.click({ clickCount: 3 });
    await loginInput.type(this.config.avitoLogin, { delay: 40 });

    const passwordInput = await this.waitForSelectorAny(page, SELECTORS.passwordInput, 5000);
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(this.config.avitoPassword, { delay: 40 });
    await this.tryClickSubmit(page);

    // After credentials, exactly three valid outcomes within 60s:
    //   - URL leaves the login screen → credentials accepted, no 2FA;
    //   - 2FA input appears → continue with the code flow;
    //   - neither → bail, let ensureAuthorized retry.
    const outcomeHandle = await page
      .waitForFunction(
        (codeSelector: string) => {
          if (document.querySelector(codeSelector)) return '2fa';
          if (!location.href.includes('login')) return 'redirected';
          return null;
        },
        { timeout: 60000, polling: 200 },
        SELECTORS.codeInput,
      )
      .catch(() => null);

    if (!outcomeHandle) {
      throw new Error('Login did not complete within 60s: neither redirect nor 2FA prompt');
    }

    const outcome = (await outcomeHandle.jsonValue()) as '2fa' | 'redirected';
    await outcomeHandle.dispose();

    if (outcome === '2fa') {
      this.logger.log('2FA prompt detected — awaiting code from frontend');
      this.setState('awaiting_code', 'Avito requested 2FA code');

      const code = await this.requestCodeFromUser('SMS or app code requested by Avito');
      const codeInput = await this.waitForSelectorAny(page, SELECTORS.codeInput, 5000);
      await codeInput.click({ clickCount: 3 });
      await codeInput.type(code, { delay: 40 });
      await this.tryClickSubmit(page);

      // Same 60s window as after credentials: only a URL redirect off the
      // login screen counts as success. Otherwise bail and retry.
      const redirected = await page
        .waitForFunction(
          () => !location.href.includes('login'),
          { timeout: 60000, polling: 200 },
        )
        .catch(() => null);
      if (!redirected) {
        throw new Error('2FA did not complete within 60s: no redirect');
      }
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
    // Caller awaits domcontentloaded before this. Give Avito a 5s window
    // to redirect us off /profile/messenger (server-side or via client JS,
    // including hash routes). If a redirect lands within that window we're
    // unauthorized; otherwise the session is valid.
    const left = await page
      .waitForFunction(
        () => !location.pathname.includes('/profile/messenger'),
        { timeout: 5000, polling: 200 },
      )
      .catch(() => null);
    return left === null;
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
