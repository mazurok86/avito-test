import { Module } from '@nestjs/common';

import { BrowserService } from './browser.service';
import { AvitoAuthService } from './auth.service';
import { ChatWatcherService } from './chat-watcher.service';

@Module({
  providers: [BrowserService, AvitoAuthService, ChatWatcherService],
  exports: [AvitoAuthService],
})
export class AvitoModule {}
