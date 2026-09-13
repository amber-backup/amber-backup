import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { USER_LOCALES, UserLocale } from '../../database/database.types';

export class LoginDto {
  @ApiProperty({ example: 'admin@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'changeme' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword!: string;
}

export class UpdatePreferencesDto {
  @ApiPropertyOptional({
    enum: USER_LOCALES,
    nullable: true,
    description: 'UI language; null follows the browser',
  })
  @IsOptional()
  @IsIn(USER_LOCALES)
  locale?: UserLocale | null;
}

export class LoginTotpDto {
  @ApiProperty({ description: 'Challenge token from the password step' })
  @IsString()
  @MinLength(1)
  challengeToken!: string;

  @ApiProperty({ description: '6-digit TOTP code or a recovery code' })
  @IsString()
  @MinLength(6)
  code!: string;
}

export class EnableTotpDto {
  @ApiProperty({ description: '6-digit code from the authenticator app' })
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class DisableTotpDto {
  @ApiProperty({ description: 'Current account password' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class PasskeyRegisterDto {
  @ApiProperty({ type: Object, description: 'RegistrationResponseJSON from the browser' })
  @IsObject()
  response!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Device label, e.g. "MacBook Touch ID"' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class PasskeyLoginDto {
  @ApiProperty({ type: Object, description: 'AuthenticationResponseJSON from the browser' })
  @IsObject()
  response!: Record<string, unknown>;
}

export class CreateUserDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  displayName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;
}

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAdmin?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;

  @ApiPropertyOptional({ description: 'New password (local accounts only)' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @ApiPropertyOptional({
    enum: ['local', 'sso'],
    description:
      'Switch how the account signs in. Moving to SSO clears its password and 2FA; moving to local requires `password` in the same request.',
  })
  @IsOptional()
  @IsIn(['local', 'sso'])
  authSource?: 'local' | 'sso';
}

export class CreateGrantDto {
  @ApiProperty({ enum: ['target', 'source', 'job'] })
  @IsIn(['target', 'source', 'job'])
  resourceType!: 'target' | 'source' | 'job';

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  resourceId!: string;

  @ApiProperty({ enum: ['view', 'operate', 'manage'] })
  @IsIn(['view', 'operate', 'manage'])
  accessLevel!: 'view' | 'operate' | 'manage';
}

/** One resource an API key is restricted to. */
export class ApiKeyScopeResourceDto {
  @ApiProperty({ enum: ['target', 'source', 'job'] })
  @IsIn(['target', 'source', 'job'])
  type!: 'target' | 'source' | 'job';

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  id!: string;
}

export class ApiKeyScopeDto {
  @ApiProperty({ type: [String], example: ['read', 'backup'] })
  @IsArray()
  @IsString({ each: true })
  actions!: string[];

  @ApiPropertyOptional({ type: [ApiKeyScopeResourceDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApiKeyScopeResourceDto)
  resources?: ApiKeyScopeResourceDto[];
}

export class CreateApiKeyDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ type: ApiKeyScopeDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiKeyScopeDto)
  scopes?: ApiKeyScopeDto;

  @ApiPropertyOptional({ description: 'Days until expiry; omit = never' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expiresInDays?: number;
}
