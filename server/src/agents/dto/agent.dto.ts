import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateEnrollmentTokenDto {
  @ApiPropertyOptional({ description: 'Suggested agent name' })
  @IsOptional()
  @IsString()
  intendedAgentName?: string;

  @ApiPropertyOptional({ description: 'Token lifetime in minutes', default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  expiresInMinutes?: number;

  @ApiPropertyOptional({ enum: ['binary', 'docker'], default: 'binary' })
  @IsOptional()
  @IsIn(['binary', 'docker'])
  deployMethod?: 'binary' | 'docker';
}

export class UpdateAgentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  token!: string;

  @ApiProperty()
  @IsString()
  agentName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  hostname?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  os?: string;

  @ApiPropertyOptional({ description: 'Agent public key (base64)' })
  @IsOptional()
  @IsString()
  pubkey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  agentVersion?: string;
}

export class PollDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resticVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  agentVersion?: string;
}

export class TaskProgressDto {
  @ApiProperty({ type: Object })
  stats!: Record<string, unknown>;
}

export class TaskResultDto {
  @ApiProperty({ enum: ['success', 'failed'] })
  @IsIn(['success', 'failed'])
  status!: 'success' | 'failed';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  snapshotId?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  stats?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  forgetResult?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  error?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  log?: string;
}
