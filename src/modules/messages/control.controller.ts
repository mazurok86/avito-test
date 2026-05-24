import { BadRequestException, Controller, Post } from '@nestjs/common';

import { ChatWatcherService } from '../avito/chat-watcher.service';

@Controller('control')
export class ControlController {
  constructor(private readonly watcher: ChatWatcherService) {}

  // 200 here only means "we accepted your start request and kicked off the
  // watcher in the background". Actual progress (auth flow → authorized →
  // watching) is reported via status:change WS events. A second call while
  // the watcher is already running returns 400 — once-per-process.
  @Post('start')
  start(): { started: boolean } {
    if (this.watcher.isStarted()) {
      throw new BadRequestException('Watcher is already running');
    }
    this.watcher.startManual();
    return { started: true };
  }

  // Destructive: closes the browser and wipes the chrome-profile contents
  // (cookies, login data, history, cache). Allowed in any runState — if
  // the watcher is currently running it is forcibly torn down. The UI
  // gates this behind an explicit confirm() prompt.
  @Post('reset')
  async reset(): Promise<{ reset: boolean }> {
    await this.watcher.fullReset();
    return { reset: true };
  }
}
