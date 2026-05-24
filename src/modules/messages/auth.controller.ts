import { BadRequestException, Body, Controller, Post } from '@nestjs/common';

import { AvitoAuthService } from '../avito/auth.service';
import { SubmitAuthCodeDto } from './auth-code.dto';
import { SubmitAuthCredentialsDto } from './auth-credentials.dto';

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

  // Same semantics as /auth/code: 200 means "we have the credentials and
  // will hand them to Avito". Success/failure of the login itself surfaces
  // via the auth state stream (status:change → authorized | awaiting_code | error).
  @Post('credentials')
  submitCredentials(@Body() dto: SubmitAuthCredentialsDto): { received: boolean } {
    if (!this.auth.isAwaitingCredentials()) {
      throw new BadRequestException('No credentials are currently being requested');
    }
    const received = this.auth.submitCredentials(dto.login.trim(), dto.password);
    return { received };
  }
}
