import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';

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
    enum: ['binary', 'docker', 'docker-compose'],
    default: 'binary',
  })
  @IsOptional()
  @IsIn(['binary', 'docker', 'docker-compose'])
  deployMethod?: 'binary' | 'docker' | 'docker-compose';
}

export class SetGlobalEnrollmentDto {
  @ApiProperty({ description: 'Enable or disable global self-registration' })
  @IsBoolean()
  enabled!: boolean;
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  error?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  log?: string;
}

export class TaskResultDto {
  @ApiProperty({ enum: ['success', 'failed'] })
  @IsIn(['success', 'failed'])
  status!: 'success' | 'failed';

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
    description: 'For a check: restic reported integrity errors (status is then failed)',
  })
  @IsOptional()
  @IsBoolean()
  damaged?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  error?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  log?: string;
}
