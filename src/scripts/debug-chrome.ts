// Debug entrypoint: launches Chrome with the exact same BrowserService config
// the prod app uses (stealth + evasions + Xvfb + openbox + Russian locale),
// opens a single page, and holds the process open so you can drive the browser
// manually via VNC.
//
// Run inside the container:
//   docker compose run --rm --service-ports avito-relay \
//       npm run debug:chrome
//   # …then open http://localhost:6080/vnc.html
//
// Override the start URL:
//   docker compose run --rm --service-ports avito-relay \
//       node dist/scripts/debug-chrome.js https://www.avito.ru/moscow
//
// Important: this script does NOT trigger the auth flow. If the chrome-profile
// volume is empty (or you want a fresh session), log in manually through the
// VNC window — credentials/cookies will be persisted into the volume just like
// in normal app runs, and subsequent app starts will pick the session up.

import { AppConfigService } from '../config/config.service';
import { BrowserService } from '../modules/avito/browser.service';

const DEFAULT_URL = 'https://www.avito.ru/';

async function main(): Promise<void> {
  const url = process.argv[2] ?? DEFAULT_URL;

  const config = new AppConfigService();
  const browser = new BrowserService(config);

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  console.log('---');
  console.log(`[debug-chrome] opened: ${url}`);
  if (process.env.ENABLE_VNC === 'true') {
    console.log('[debug-chrome] VNC ready:');
    console.log('[debug-chrome]   browser: http://localhost:6080/vnc.html');
    console.log('[debug-chrome]   client:  vnc://localhost:5900');
  } else {
    console.log('[debug-chrome] WARN: ENABLE_VNC is not "true" — you will not');
    console.log('[debug-chrome]       be able to see Chrome. Set ENABLE_VNC=true');
    console.log('[debug-chrome]       in docker-compose.yml and retry.');
  }
  console.log('[debug-chrome] Ctrl+C to stop.');
  console.log('---');

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[debug-chrome] received ${signal}, closing browser`);
    await browser.onModuleDestroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Hold the event loop open indefinitely; the signal handlers above are the
  // only exit path.
  await new Promise<void>(() => {});
}

main().catch((err: unknown) => {
  console.error('[debug-chrome] fatal:', err);
  process.exit(1);
});
