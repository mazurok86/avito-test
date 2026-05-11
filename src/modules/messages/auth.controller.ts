import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AvitoAuthService } from '../avito/auth.service';
import { SubmitAuthCodeDto } from './auth-code.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AvitoAuthService,
    private readonly events: EventEmitter2,
  ) {}

  @Post('code')
  submitCode(@Body() dto: SubmitAuthCodeDto): { accepted: boolean } {
    if (!this.auth.isAwaitingCode()) {
      throw new BadRequestException('No 2FA code is currently being requested');
    }
    const accepted = this.auth.submitCode(dto.code.trim());
    if (accepted) this.events.emit('auth.code_accepted');
    return { accepted };
  }
}
