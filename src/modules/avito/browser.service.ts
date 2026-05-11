import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AppConfigService } from '../../config/config.service';

puppeteerExtra.use(StealthPlugin());

@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser | null = null;

  constructor(private readonly config: AppConfigService) {}

  async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;

    const userDataDir = resolve(this.config.userDataDir);
    await mkdir(userDataDir, { recursive: true });

    this.logger.log(
      `Launching Chromium (headless=${this.config.headless}, profile=${userDataDir})`,
    );

    this.browser = await puppeteerExtra.launch({
      headless: this.config.headless,
      userDataDir,
      executablePath: this.config.executablePath,
      defaultViewport: { width: 1366, height: 850 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--lang=ru-RU,ru',
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
    return browser.newPage();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      this.logger.log('Closing browser…');
      try {
        await this.browser.close();
      } catch (err) {
        this.logger.warn(`Failed to close browser cleanly: ${(err as Error).message}`);
      }
      this.browser = null;
    }
  }
}
