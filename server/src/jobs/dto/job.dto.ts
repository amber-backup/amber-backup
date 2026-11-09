import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ResticOptions, JobNotifyConfig } from '../../database/database.types';
import { HypervJobConfigDto } from '../../hyperv/dto/hyperv.dto';

export class CreateJobDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({
    enum: ['files', 'hyperv'],
    default: 'files',
    description: 'files: host paths; hyperv: VMs of a Hyper-V host (runs on its agent)',
  })
  @IsOptional()
  @IsIn(['files', 'hyperv'])
  sourceKind?: 'files' | 'hyperv';

  @ApiProperty({
    enum: ['local', 'agent'],
    description: 'Where the data lives (a Hyper-V job always runs on its host\'s agent)',
  })
  @IsIn(['local', 'agent'])
  location!: 'local' | 'agent';

  @ApiPropertyOptional({ description: 'Required when location = agent (not for Hyper-V jobs)' })
  @ValidateIf((o) => o.location === 'agent' && o.sourceKind !== 'hyperv')
  @IsUUID()
  agentId?: string;

  @ApiProperty({ type: [String], example: ['/home', '/etc'], description: 'Not used by Hyper-V jobs' })
  @ValidateIf((o) => o.sourceKind !== 'hyperv')
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  paths!: string[];

  @ApiPropertyOptional({ description: 'Hyper-V jobs: the host whose VMs are backed up' })
  @ValidateIf((o) => o.sourceKind === 'hyperv')
  @IsUUID()
  hypervHostId?: string;

  @ApiPropertyOptional({ type: HypervJobConfigDto, description: 'Hyper-V jobs: VM selection' })
  @ValidateIf((o) => o.sourceKind === 'hyperv')
  @ValidateNested()
  @Type(() => HypervJobConfigDto)
  hypervConfig?: HypervJobConfigDto;

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

  @ApiPropertyOptional({
    type: Object,
    description:
      "Per-job override of the connection's overridable credentials (e.g. a REST server's username/password)",
  })
  @IsOptional()
  @IsObject()
  repoCredentials?: Record<string, string> | null;

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

  @ApiPropertyOptional({
    description: 'How often a failed backup is retried (0 = never)',
    minimum: 0,
    maximum: 10,
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  retryMax?: number;

  @ApiPropertyOptional({
    description: 'Seconds to wait before each retry',
    minimum: 10,
    maximum: 86400,
    default: 300,
  })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(86400)
  retryDelaySeconds?: number;

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

  @ApiPropertyOptional({
    type: Object,
    description: "Per-job override of the connection's overridable credentials",
  })
  @IsOptional()
  @IsObject()
  repoCredentials?: Record<string, string>;

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

  @ApiPropertyOptional({ description: 'Hyper-V jobs: move to another host' })
  @IsOptional()
  @IsUUID()
  hypervHostId?: string;

  @ApiPropertyOptional({ type: HypervJobConfigDto, description: 'Hyper-V jobs: VM selection' })
  @IsOptional()
  @ValidateNested()
  @Type(() => HypervJobConfigDto)
  hypervConfig?: HypervJobConfigDto;

  @ApiPropertyOptional({ description: 'Connection id, or null for a local repo' })
  @IsOptional()
  @IsUUID()
  targetId?: string | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  repoConfig?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description:
      "Per-job override of the connection's overridable credentials: given fields are merged into the existing override, null removes it, omitting the property leaves it untouched",
  })
  @IsOptional()
  @IsObject()
  repoCredentials?: Record<string, string> | null;

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

  @ApiPropertyOptional({
    description: 'How often a failed backup is retried (0 = never)',
    minimum: 0,
    maximum: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  retryMax?: number;

  @ApiPropertyOptional({
    description: 'Seconds to wait before each retry',
    minimum: 10,
    maximum: 86400,
  })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(86400)
  retryDelaySeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
