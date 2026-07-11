import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
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
