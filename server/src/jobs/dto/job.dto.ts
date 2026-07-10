import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ResticOptions, JobNotifyConfig } from '../../database/database.types';

export class CreateJobDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ enum: ['local', 'agent'], description: 'Where the data lives' })
  @IsIn(['local', 'agent'])
  location!: 'local' | 'agent';

  @ApiPropertyOptional({ description: 'Required when location = agent' })
  @ValidateIf((o) => o.location === 'agent')
  @IsUUID()
  agentId?: string;

  @ApiProperty({ type: [String], example: ['/home', '/etc'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  paths!: string[];

  @ApiProperty()
  @IsUUID()
  targetId!: string;

  @ApiProperty({ example: '0 */6 * * *' })
  @IsString()
  cronExpr!: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  resticOptions?: ResticOptions;

  @ApiPropertyOptional({ type: Object, description: 'Notification channels + triggers' })
  @IsOptional()
  @IsObject()
  notify?: JobNotifyConfig;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateJobDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: ['local', 'agent'] })
  @IsOptional()
  @IsIn(['local', 'agent'])
  location?: 'local' | 'agent';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  paths?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cronExpr?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  resticOptions?: ResticOptions;

  @ApiPropertyOptional({ type: Object, description: 'Notification channels + triggers' })
  @IsOptional()
  @IsObject()
  notify?: JobNotifyConfig;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
