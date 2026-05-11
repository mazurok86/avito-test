import { IsString, Length } from 'class-validator';

export class SubmitAuthCodeDto {
  @IsString()
  @Length(3, 12)
  code!: string;
}
