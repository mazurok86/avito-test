import { Controller, Get } from '@nestjs/common';

import { StatusService, type StatusSnapshot } from './status.service';

@Controller('status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  get(): StatusSnapshot {
    return this.status.getSnapshot();
  }
}
