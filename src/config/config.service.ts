import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  readonly port: number = Number(process.env.PORT ?? 3000);

  readonly avitoLogin: string = process.env.AVITO_LOGIN?.trim() ?? '';
  readonly avitoPassword: string = process.env.AVITO_PASSWORD ?? '';
  readonly targetUserName: string = (process.env.TARGET_USER_NAME ?? '').trim();

  readonly headless: boolean = (process.env.PUPPETEER_HEADLESS ?? 'false').toLowerCase() === 'true';
  readonly userDataDir: string = process.env.PUPPETEER_USER_DATA_DIR ?? './.chrome-profile';
  readonly executablePath: string | undefined = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  readonly authMaxAttempts: number = Number(process.env.AUTH_MAX_ATTEMPTS ?? 3);

  validate(): void {
    const missing: string[] = [];
    if (!this.avitoLogin) missing.push('AVITO_LOGIN');
    if (!this.avitoPassword) missing.push('AVITO_PASSWORD');
    if (!this.targetUserName) missing.push('TARGET_USER_NAME');

    if (missing.length > 0) {
      this.logger.warn(
        `Missing env variables: ${missing.join(', ')}. The service will start but Avito login will fail.`,
      );
    }
  }
}
