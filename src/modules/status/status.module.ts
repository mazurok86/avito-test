import { Module } from '@nestjs/common';

import { StatusController } from './status.controller';
import { StatusService } from './status.service';

@Module({
  providers: [StatusService],
  controllers: [StatusController],
  exports: [StatusService],
})
export class StatusModule {}
