import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
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
  // Needs a class-validator decorator: with the global ValidationPipe's
  // `whitelist` + `forbidNonWhitelisted`, an undecorated property is treated as
  // non-whitelisted and the request is rejected with 400 — which silently broke
  // all agent progress updates.
  @ApiProperty({ type: Object })
  @IsObject()
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
