import { BadRequestException, Body, Controller, Post } from '@nestjs/common';

import { AvitoAuthService } from '../avito/auth.service';
import { SubmitAuthCodeDto } from './auth-code.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AvitoAuthService) {}

  // 200 here only means "we received your code and passed it to Avito".
  // The auth.code_accepted event is emitted later by AvitoAuthService once
  // Avito actually accepts the code (post-2FA redirect lands).
  @Post('code')
  submitCode(@Body() dto: SubmitAuthCodeDto): { received: boolean } {
    if (!this.auth.isAwaitingCode()) {
      throw new BadRequestException('No 2FA code is currently being requested');
    }
    const received = this.auth.submitCode(dto.code.trim());
    return { received };
  }
}
