import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { isValidAllowlistEntry } from '../../common/ip-allowlist';
import { truncateMiddle } from '../../common/truncate';
import { HypervInventoryDto } from '../../hyperv/dto/hyperv.dto';
import {
  ProxmoxAgentInfoDto,
  ProxmoxGuestResultDto,
  ProxmoxInventoryDto,
} from '../../proxmox/dto/proxmox.dto';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Longest log an agent result keeps (longer ones keep their start and end). */
export const RESULT_LOG_MAX = 200_000;
/** Longest error text an agent result keeps. */
export const RESULT_ERROR_MAX = 20_000;

/**
 * Shortens an over-long text field instead of rejecting the whole result: an
 * agent's outcome must never be lost to a chatty log (head and tail are kept).
 */
export function TruncateTo(max: number): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? truncateMiddle(value, max) : value));
}

export class CreateEnrollmentTokenDto {
  @ApiPropertyOptional({ description: 'Suggested agent name' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  intendedAgentName?: string;

  @ApiPropertyOptional({ description: 'Token lifetime in minutes', default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  expiresInMinutes?: number;

  @ApiPropertyOptional({
    enum: ['binary', 'docker', 'docker-compose', 'windows'],
    default: 'binary',
    description: 'windows: PowerShell installer that registers a Windows service',
  })
  @IsOptional()
  @IsIn(['binary', 'docker', 'docker-compose', 'windows'])
  deployMethod?: 'binary' | 'docker' | 'docker-compose' | 'windows';
}

export class SetGlobalEnrollmentDto {
  @ApiProperty({ description: 'Enable or disable global self-registration' })
  @IsBoolean()
  enabled!: boolean;
}

@ValidatorConstraint({ name: 'allowlistEntry' })
class AllowlistEntryConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidAllowlistEntry(value);
  }

  defaultMessage(): string {
    return 'each value in allowedIps must be an IP address or CIDR range';
  }
}

export class UpdateAgentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(3600)
  pollIntervalSeconds?: number;

  @ApiPropertyOptional({ type: [String], description: 'Free-form labels, e.g. ["prod", "eu"]' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  labels?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'IP addresses / CIDR ranges the agent may connect from; empty allows any address',
    example: ['203.0.113.7', '10.0.0.0/8'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Validate(AllowlistEntryConstraint, { each: true })
  allowedIps?: string[];
}

// --- Agent-facing DTOs ---

export class EnrollDto {
  @ApiProperty()
  @IsString()
  @MaxLength(512)
  token!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  agentName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  hostname?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  os?: string;

  @ApiPropertyOptional({ description: 'Agent public key (base64)' })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  pubkey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;
}

export class PollDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resticVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Task types the agent supports beyond backup/restore, e.g. ['check']",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  capabilities?: string[];

  @ApiPropertyOptional({
    type: ProxmoxAgentInfoDto,
    description: 'Agents on a Proxmox VE node: the cluster and node they run on',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProxmoxAgentInfoDto)
  proxmox?: ProxmoxAgentInfoDto;

  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description:
      'Every task the agent received and has not yet reported (queued, running, or result awaiting delivery). ' +
      'Running tasks claimed before the previous poll that are missing here are failed. null counts as an empty list; ' +
      'omitted by older agents.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4096)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  runningTaskIds?: string[] | null;
}

export class TaskProgressDto {
  // Needs a class-validator decorator: with the global ValidationPipe's
  // `whitelist` + `forbidNonWhitelisted`, an undecorated property is treated as
  // non-whitelisted and the request is rejected with 400 — which silently broke
  // all agent progress updates.
  @ApiProperty({ type: Object })
  @IsObject()
  stats!: Record<string, unknown>;
}

/** Outcome of the prune an agent ran after a backup's retention asked for one. */
export class PruneResultDto {
  @ApiProperty({ enum: ['success', 'failed'] })
  @IsIn(['success', 'failed'])
  status!: 'success' | 'failed';

  @ApiProperty({ description: 'ISO-8601 start time' })
  @IsDateString()
  startedAt!: string;

  @ApiProperty({ description: 'ISO-8601 end time' })
  @IsDateString()
  finishedAt!: string;

  @ApiPropertyOptional({ description: 'Longer texts are shortened (start and end kept)' })
  @IsOptional()
  @IsString()
  @TruncateTo(RESULT_ERROR_MAX)
  @MaxLength(RESULT_ERROR_MAX)
  error?: string;

  @ApiPropertyOptional({ description: 'Longer logs are shortened (start and end kept)' })
  @IsOptional()
  @IsString()
  @TruncateTo(RESULT_LOG_MAX)
  @MaxLength(RESULT_LOG_MAX)
  log?: string;
}

/** Repository figures an agent read with `restic stats` after its task. */
export class RepoStatsDto {
  @ApiProperty({ description: 'Deduplicated repository size in bytes (raw-data mode)' })
  @IsInt()
  @Min(0)
  sizeBytes!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  snapshotCount!: number;
}

export class TaskResultDto {
  @ApiProperty({
    enum: ['success', 'failed', 'cancelled'],
    description: 'cancelled: the agent stopped the task after it was cancelled on the server',
  })
  @IsIn(['success', 'failed', 'cancelled'])
  status!: 'success' | 'failed' | 'cancelled';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  snapshotId?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  stats?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  forgetResult?: unknown;

  @ApiPropertyOptional({ type: PruneResultDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PruneResultDto)
  prune?: PruneResultDto;

  @ApiPropertyOptional({
    type: RepoStatsDto,
    description: 'Repository figures the agent read after a backup or for a stats task',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RepoStatsDto)
  repoStats?: RepoStatsDto;

  @ApiPropertyOptional({ description: 'Why reading the repository figures failed' })
  @IsOptional()
  @IsString()
  @TruncateTo(RESULT_ERROR_MAX)
  @MaxLength(RESULT_ERROR_MAX)
  repoStatsError?: string;

  @ApiPropertyOptional({
    type: HypervInventoryDto,
    description: 'For a hyperv-inventory task: the VMs of the host',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => HypervInventoryDto)
  hypervInventory?: HypervInventoryDto;

  @ApiPropertyOptional({
    type: ProxmoxInventoryDto,
    description: 'For a proxmox-inventory task: nodes, storages and guests of the cluster',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProxmoxInventoryDto)
  proxmoxInventory?: ProxmoxInventoryDto;

  @ApiPropertyOptional({
    type: ProxmoxGuestResultDto,
    description: "For a proxmox-backup task: the guest's outcome",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProxmoxGuestResultDto)
  proxmoxGuest?: ProxmoxGuestResultDto;

  @ApiPropertyOptional({
    description: 'For a check: restic reported integrity errors (status is then failed)',
  })
  @IsOptional()
  @IsBoolean()
  damaged?: boolean;

  @ApiPropertyOptional({ description: 'Longer texts are shortened (start and end kept)' })
  @IsOptional()
  @IsString()
  @TruncateTo(RESULT_ERROR_MAX)
  @MaxLength(RESULT_ERROR_MAX)
  error?: string;

  @ApiPropertyOptional({ description: 'Longer logs are shortened (start and end kept)' })
  @IsOptional()
  @IsString()
  @TruncateTo(RESULT_LOG_MAX)
  @MaxLength(RESULT_LOG_MAX)
  log?: string;
}
