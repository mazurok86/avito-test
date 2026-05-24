import { Module } from '@nestjs/common';

import { AvitoModule } from '../avito/avito.module';
import { StatusModule } from '../status/status.module';
import { MessagesGateway } from './messages.gateway';
import { AuthController } from './auth.controller';
import { ControlController } from './control.controller';

@Module({
  imports: [AvitoModule, StatusModule],
  providers: [MessagesGateway],
  controllers: [AuthController, ControlController],
})
export class MessagesModule {}
