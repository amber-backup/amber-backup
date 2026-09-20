import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SSO_PROVIDER_TYPES, SsoProviderType } from '../settings.service';

export class UpdateAgentSettingsDto {
  @ApiProperty({ minimum: 30, maximum: 3600 })
  @IsInt()
  @Min(30)
  @Max(3600)
  offlineTimeoutSeconds!: number;
}

export class UpdateTimezoneDto {
  @ApiProperty({
    description:
      'IANA zone name that cron schedules and displayed timestamps are read in',
    example: 'Europe/Berlin',
  })
  @IsString()
  @MaxLength(64)
  timezone!: string;
}

export class UpdateAuthSettingsDto {
  @ApiProperty({ description: 'Accept password and passkey logins' })
  @IsBoolean()
  localLoginEnabled!: boolean;
}

export class SsoProviderDto {
  @ApiPropertyOptional({ description: 'Set when editing an existing provider' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ enum: SSO_PROVIDER_TYPES })
  @IsIn(SSO_PROVIDER_TYPES)
  type!: SsoProviderType;

  @ApiPropertyOptional({ description: 'Login button label override' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ description: 'OIDC issuer base URL' })
  @IsOptional()
  @IsString()
  issuerUrl?: string;

  @ApiPropertyOptional({ description: 'Entra directory (tenant) id' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Blank leaves the stored secret unchanged' })
  @IsOptional()
  @IsString()
  clientSecret?: string;
}

export class UpdateSsoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: [SsoProviderDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SsoProviderDto)
  providers?: SsoProviderDto[];
}

export class UpdateAdminIpAllowlistDto {
  @ApiProperty({
    type: [String],
    description:
      'IP addresses / CIDR ranges administrators may connect from (in addition to ADMIN_ALLOWED_IPS); empty removes the UI-maintained restriction',
    example: ['203.0.113.7', '10.0.0.0/8'],
  })
  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  entries!: string[];
}
