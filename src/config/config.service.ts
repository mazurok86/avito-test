import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  readonly port: number = Number(process.env.PORT ?? 3000);

  // Avito login/password are NOT read from env anymore — the user supplies
  // them via the UI when the auth flow asks (event `auth.needs_credentials`,
  // POST /auth/credentials). Keeps secrets out of disk-resident .env files.
  readonly targetUserName: string = (process.env.TARGET_USER_NAME ?? '').trim();

  readonly userDataDir: string = process.env.PUPPETEER_USER_DATA_DIR ?? './.chrome-profile';
  readonly executablePath: string | undefined = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  readonly debugScreenshots: boolean =
    (process.env.DEBUG_SCREENSHOTS ?? 'false').toLowerCase() === 'true';

  validate(): void {
    const missing: string[] = [];
    if (!this.targetUserName) missing.push('TARGET_USER_NAME');

    if (missing.length > 0) {
      this.logger.warn(
        `Missing env variables: ${missing.join(', ')}. The service will start but chat watching will not be configured.`,
      );
    }
  }
}
