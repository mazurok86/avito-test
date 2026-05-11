import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';

import { AppConfigModule } from './config/config.module';
import { AvitoModule } from './modules/avito/avito.module';
import { MessagesModule } from './modules/messages/messages.module';
import { StatusModule } from './modules/status/status.module';

@Module({
  imports: [
    AppConfigModule,
    EventEmitterModule.forRoot({ wildcard: false, maxListeners: 50 }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'client'),
      serveRoot: '/',
    }),
    AvitoModule,
    StatusModule,
    MessagesModule,
  ],
})
export class AppModule {}
