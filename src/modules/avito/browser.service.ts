import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { AppConfigService } from '../../config/config.service';
import { applyFingerprintOverrides } from './stealth-evasions';

// Disable three stealth evasions whose defaults contradict our explicit
// choice to present as a Linux desktop user with Russian locale:
//
//   * webgl.vendor — would advertise Mac-flavored Intel strings; replaced by
//     our own evasion in stealth-evasions.ts (Mesa Intel UHD).
//   * user-agent-override — defaults to maskLinux: true, which rewrites the
//     UA `(X11; Linux x86_64)` segment to `(Windows NT 10.0; Win64; x64)` and
//     fixes navigator.platform / Sec-CH-UA-Platform to match. We want the
//     real Linux UA Chrome reports natively (X11/Linux is a legitimate ~3-4%
//     of desktop users), consistent with our WebGL/font/Xvfb stack.
//   * navigator.languages — defaults to ['en-US', 'en'], which contradicts
//     our --lang=ru-RU,ru Chrome flag (and the HTTP Accept-Language we set
//     via setExtraHTTPHeaders). Chrome's native --lang already drives
//     navigator.languages correctly to ['ru-RU', 'ru'], so the evasion is
//     not just unnecessary, it's actively harmful.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('webgl.vendor');
stealth.enabledEvasions.delete('user-agent-override');
stealth.enabledEvasions.delete('navigator.languages');
puppeteerExtra.use(stealth);

// We do NOT override the User-Agent. The container ships real Chrome and runs
// headful under Xvfb + openbox, so its native UA ("X11; Linux x86_64 …
// Chrome/<ver>") is internally consistent with everything a site can probe:
// navigator.platform, Sec-CH-UA-Platform, WebGL renderer (after our spoof),
// installed font set, window decorations from the WM. Faking Windows here
// would create contradictions that are easier to detect than presenting
// honestly as a (legitimate, ~3-4% of desktop) Linux user.

// Window smaller than the Xvfb screen (1920×1080) so openbox can draw a real
// title bar + borders — outerWidth/Height ≠ innerWidth/Height, and a non-zero
// window position both match a real desktop session.
const WINDOW_WIDTH = 1366;
const WINDOW_HEIGHT = 900;
const WINDOW_X = 80;
const WINDOW_Y = 40;

@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser | null = null;

  constructor(private readonly config: AppConfigService) {}

  async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;

    const userDataDir = resolve(this.config.userDataDir);
    await mkdir(userDataDir, { recursive: true });

    // Apply preference tweaks that suppress Chrome's UI bubbles which we
    // can't otherwise dismiss without manual VNC interaction:
    //   * "Save password?" after each login
    //   * "Chrome wasn't shut down properly — restore tabs?" after every
    //     container restart (SIGTERM → Chrome exits ungracefully)
    await this.applyStartupPreferences(userDataDir);

    this.logger.log(`Launching Chrome (headful, profile=${userDataDir})`);

    // Always headful — locally a real Chrome window opens; in Docker / on
    // headless servers we rely on Xvfb (see docker/entrypoint.sh or wrap
    // local runs with `xvfb-run`). Puppeteer's `headless: true` is
    // trivially fingerprinted by Avito, so we never want it.
    this.browser = await puppeteerExtra.launch({
      headless: false,
      userDataDir,
      executablePath: this.config.executablePath,
      // null lets the Chrome window drive the viewport, matching real desktop
      // behavior (where viewport == window inner size, not a fixed CDP value).
      defaultViewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
        `--window-position=${WINDOW_X},${WINDOW_Y}`,
        '--lang=ru-RU,ru',
        '--accept-lang=ru-RU,ru;q=0.9,en;q=0.8',
        '--disable-features=Translate,IsolateOrigins,site-per-process,AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        // QUIC (HTTP/3) goes over UDP, and Docker Desktop's NAT (gvisor-vsock
        // on Mac, especially under amd64-on-arm64 emulation) drops/fragments
        // UDP unpredictably. Chrome's QUIC fallback timer is 30s+, so dozens
        // of requests sit pending while we wait for it. Force HTTP/2 only.
        '--disable-quic',
        // Suppress Chrome's own non-user-driven background traffic:
        // Safe Browsing list updates, Field Trial server pings, component
        // updates, crash uploads. These contribute extra "pending" requests
        // and serve no purpose for our single-site automation.
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
      ],
    });

    this.browser.on('disconnected', () => {
      this.logger.warn('Browser disconnected');
      this.browser = null;
    });

    return this.browser;
  }

  async newPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    // Fingerprint overrides must register BEFORE any page script runs.
    // evaluateOnNewDocument re-injects on every navigation, so a single
    // call here covers the page's whole lifetime.
    await page.evaluateOnNewDocument(applyFingerprintOverrides);

    // Accept-Language: belt-and-suspenders alongside --lang=ru-RU,ru, so any
    // request bypassing Chrome's default header (e.g. fetch() from a worker)
    // still advertises ru-RU. emulateTimezone reinforces TZ=Europe/Moscow.
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' });
    await page.emulateTimezone('Europe/Moscow');

    return page;
  }

  // Writes (or merges into) <userDataDir>/Default/Preferences to suppress
  // Chrome UI prompts that would otherwise need manual VNC interaction.
  // Safe to call before every launch: we read the existing JSON (if any),
  // set just the relevant keys, write back. Chrome locks the file while
  // running, so we MUST do this with Chrome down.
  private async applyStartupPreferences(userDataDir: string): Promise<void> {
    const defaultDir = join(userDataDir, 'Default');
    await mkdir(defaultDir, { recursive: true });
    const prefsPath = join(defaultDir, 'Preferences');

    type Prefs = Record<string, unknown> & { profile?: Record<string, unknown> };
    let prefs: Prefs = {};
    try {
      prefs = JSON.parse(await readFile(prefsPath, 'utf8')) as Prefs;
    } catch {
      // Missing on first launch, or unparseable after a Chrome crash — start
      // fresh. Chrome will repopulate non-credential preferences on launch.
    }

    // credentials_enable_service:        "Save password?" bubble
    // credentials_enable_autosignin:     auto-signin offer
    // profile.password_manager_enabled:  greys out the PM UI entirely
    prefs.credentials_enable_service = false;
    prefs.credentials_enable_autosignin = false;

    // profile.exit_type / exited_cleanly: Chrome writes "Crashed" / false
    // when killed by SIGTERM/SIGKILL (any container stop) and shows the
    // "Chrome wasn't shut down properly — restore?" bubble on next launch.
    // Forcing both to the "clean exit" values masks the bubble.
    prefs.profile = {
      ...(prefs.profile ?? {}),
      password_manager_enabled: false,
      exit_type: 'Normal',
      exited_cleanly: true,
    };

    await writeFile(prefsPath, JSON.stringify(prefs));
  }

  /**
   * Public counterpart to onModuleDestroy: close the active browser if any,
   * release its handle. Used by the full-reset path so the profile-dir
   * deletion that follows doesn't race against Chrome's open file handles.
   */
  async close(): Promise<void> {
    if (!this.browser) return;
    this.logger.log('Closing browser…');
    try {
      await this.browser.close();
    } catch (err) {
      this.logger.warn(`Failed to close browser cleanly: ${(err as Error).message}`);
    }
    this.browser = null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
