import { IsString, Length } from 'class-validator';

export class SubmitAuthCredentialsDto {
  @IsString()
  @Length(1, 200)
  login!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}
