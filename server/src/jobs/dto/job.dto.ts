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

  @ApiPropertyOptional({
    description: 'Shared connection the repository lives on; omit for a local repo',
  })
  @IsOptional()
  @IsUUID()
  targetId?: string | null;

  @ApiPropertyOptional({
    type: Object,
    description: 'Repository-specific fields (bucket, prefix, path)',
  })
  @IsOptional()
  @IsObject()
  repoConfig?: Record<string, unknown>;

  @ApiProperty({ description: 'Restic repository password' })
  @IsString()
  @MinLength(1)
  repoPassword!: string;

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

export class TestRepoDto {
  @ApiPropertyOptional({ description: 'Saved connection to test against' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ description: 'Backend type for a pre-save connection' })
  @IsOptional()
  @IsString()
  backendType?: string;

  @ApiPropertyOptional({ type: Object, description: 'Pre-save connection fields' })
  @IsOptional()
  @IsObject()
  targetConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object, description: 'Repository fields' })
  @IsOptional()
  @IsObject()
  repoConfig?: Record<string, unknown>;

  @ApiProperty({ description: 'Restic repository password' })
  @IsString()
  @MinLength(1)
  repoPassword!: string;
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

  @ApiPropertyOptional({ description: 'Connection id, or null for a local repo' })
  @IsOptional()
  @IsUUID()
  targetId?: string | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  repoConfig?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'New restic repository password' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  repoPassword?: string;

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
