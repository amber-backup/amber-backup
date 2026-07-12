import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';

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
}

export class CreateGrantDto {
  @ApiProperty({ enum: ['target', 'source', 'job'] })
  @IsString()
  resourceType!: 'target' | 'source' | 'job';

  @ApiProperty()
  @IsString()
  resourceId!: string;

  @ApiProperty({ enum: ['view', 'operate', 'manage'] })
  @IsString()
  accessLevel!: 'view' | 'operate' | 'manage';
}

export class ApiKeyScopeDto {
  @ApiProperty({ type: [String], example: ['read', 'backup'] })
  @IsArray()
  @IsString({ each: true })
  actions!: string[];

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  resources?: { type: 'target' | 'source' | 'job'; id: string }[];
}

export class CreateApiKeyDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiPropertyOptional({ type: ApiKeyScopeDto })
  @IsOptional()
  scopes?: ApiKeyScopeDto;

  @ApiPropertyOptional({ description: 'Days until expiry; omit = never' })
  @IsOptional()
  @IsInt()
  expiresInDays?: number;
}
