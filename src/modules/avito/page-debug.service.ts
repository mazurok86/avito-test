import { Injectable, Logger } from '@nestjs/common';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'puppeteer';

import { AppConfigService } from '../../config/config.service';

const DEBUG_DIR = './debug-screenshots';

/**
 * Dumps a full-page screenshot + HTML snapshot + URL/title for post-mortem
 * debugging. Two entry points:
 *   - capture()       — always fires (use for unrecoverable-failure diagnostics
 *                       where the screenshot is the whole reason to call);
 *   - captureDebug()  — gated by DEBUG_SCREENSHOTS env (use for routine,
 *                       per-step breadcrumbs that are noisy in production).
 * All errors are swallowed — capture is best-effort by design.
 */
@Injectable()
export class PageDebugService {
  private readonly logger = new Logger(PageDebugService.name);

  constructor(private readonly config: AppConfigService) {}

  async captureDebug(page: Page, label: string): Promise<void> {
    if (!this.config.debugScreenshots) return;
    await this.capture(page, label);
  }

  async capture(page: Page, label: string): Promise<void> {
    if (page.isClosed()) return;
    try {
      await mkdir(resolve(DEBUG_DIR), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeLabel = label.replace(/[^a-z0-9-]+/gi, '_');
      const base = resolve(DEBUG_DIR, `${stamp}-${safeLabel}`);

      const url = page.url();
      const title = await page.title().catch(() => '<title unavailable>');
      this.logger.log(`capture "${label}": url=${url} title=${title}`);

      await page.screenshot({ path: `${base}.png` as `${string}.png`, fullPage: true });
      const html = await page.content();
      await writeFile(`${base}.html`, html, 'utf8');
      this.logger.log(`capture "${label}" → ${base}.{png,html}`);
    } catch (err) {
      this.logger.warn(`capture "${label}" failed: ${(err as Error).message}`);
    }
  }
}
