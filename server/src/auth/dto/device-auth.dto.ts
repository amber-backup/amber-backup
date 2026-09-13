import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { DeviceAccess } from '../../database/database.types';

export class DeviceCodeRequestDto {
  @ApiProperty({
    description: 'Name of the requesting device, shown to the approving user',
    example: 'laptop-patrick',
  })
  @IsString()
  @Length(1, 64)
  // Printable characters only — the name is displayed in the approval screen.
  @Matches(/^[\p{L}\p{N} ._@()-]+$/u, {
    message: 'clientName may only contain letters, digits, spaces and ._@()-',
  })
  clientName!: string;
}

export class DeviceTokenRequestDto {
  @ApiProperty({ description: 'Secret device code from the code request' })
  @IsString()
  @Length(20, 128)
  deviceCode!: string;
}

export class DeviceUserCodeDto {
  @ApiProperty({ description: 'User code shown by the CLI', example: 'BCDF-GHJK' })
  @IsString()
  @Length(8, 12)
  userCode!: string;
}

export class DeviceApproveDto extends DeviceUserCodeDto {
  @ApiProperty({
    enum: ['full', 'read'],
    description: "'read' issues a read-only key; 'full' one with all the user's rights",
  })
  @IsIn(['full', 'read'])
  access!: DeviceAccess;

  @ApiPropertyOptional({
    description: 'Days until the issued key expires; omit = never',
    minimum: 1,
    maximum: 3650,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

export class DeviceCodeResponseDto {
  @ApiProperty({ description: 'Secret for polling; keep it on the device' })
  deviceCode!: string;

  @ApiProperty({ example: 'BCDF-GHJK' })
  userCode!: string;

  @ApiProperty({
    description: 'SPA path to open on the server (relative to its base URL)',
    example: '/#/device?code=BCDF-GHJK',
  })
  verificationPath!: string;

  @ApiProperty({ description: 'Seconds until the codes expire' })
  expiresIn!: number;

  @ApiProperty({ description: 'Minimum seconds between token polls' })
  interval!: number;
}

export class DeviceTokenResponseDto {
  @ApiProperty({ enum: ['pending', 'slow_down', 'denied', 'expired', 'approved'] })
  status!: 'pending' | 'slow_down' | 'denied' | 'expired' | 'approved';

  @ApiPropertyOptional({ description: 'Issued API key (only when approved; shown once)' })
  apiKey?: string;

  @ApiPropertyOptional()
  email?: string;

  @ApiPropertyOptional({ enum: ['full', 'read'] })
  access?: DeviceAccess;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  expiresAt?: Date | null;
}

export class DeviceRequestInfoDto {
  @ApiProperty()
  clientName!: string;

  @ApiProperty({ nullable: true, type: String })
  requestIp!: string | null;

  @ApiProperty({ nullable: true, type: String })
  requestUserAgent!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}
