import { Module } from '@nestjs/common';

import { BrowserService } from './browser.service';
import { AvitoAuthService } from './auth.service';
import { ChatWatcherService } from './chat-watcher.service';
import { PageDebugService } from './page-debug.service';

@Module({
  providers: [BrowserService, AvitoAuthService, ChatWatcherService, PageDebugService],
  exports: [AvitoAuthService, ChatWatcherService],
})
export class AvitoModule {}
