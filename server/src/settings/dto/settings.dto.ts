import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class UpdateAgentSettingsDto {
  @ApiProperty({ minimum: 30, maximum: 3600 })
  @IsInt()
  @Min(30)
  @Max(3600)
  offlineTimeoutSeconds!: number;
}

export class OidcSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  issuerUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Blank leaves the stored secret unchanged' })
  @IsOptional()
  @IsString()
  clientSecret?: string;
}

export class EntraSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Blank leaves the stored secret unchanged' })
  @IsOptional()
  @IsString()
  clientSecret?: string;
}

export class UpdateSsoDto {
  @ApiPropertyOptional({ type: OidcSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OidcSettingsDto)
  oidc?: OidcSettingsDto;

  @ApiPropertyOptional({ type: EntraSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EntraSettingsDto)
  entra?: EntraSettingsDto;
}
