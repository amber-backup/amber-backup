import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReportWindow } from '../../database/database.types';

const WINDOWS: ReportWindow[] = ['24h', '7d', '30d', '90d', '6mo', '12mo'];

/** The saved query a report runs: which jobs, which outcomes, which window. */
export class ReportDatasetDto {
  @ApiProperty({ type: [String], description: 'Job ids to include' })
  @IsArray()
  @IsUUID('all', { each: true })
  jobIds!: string[];

  @ApiProperty({
    type: [String],
    enum: ['success', 'failed'],
    example: ['success', 'failed'],
    description: 'Run outcomes to count',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['success', 'failed'], { each: true })
  statuses!: ('success' | 'failed')[];

  @ApiProperty({ enum: WINDOWS, example: '7d' })
  @IsIn(WINDOWS)
  window!: ReportWindow;
}

export class CreateReportDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ type: [String], example: ['weekly', 'ops'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ type: ReportDatasetDto })
  @ValidateNested()
  @Type(() => ReportDatasetDto)
  dataset!: ReportDatasetDto;

  @ApiProperty({ example: '0 8 * * 1', description: 'When the report is sent' })
  @IsString()
  cronExpr!: string;

  @ApiProperty({ type: [String], description: 'Notification channels to deliver to' })
  @IsArray()
  @IsUUID('all', { each: true })
  channelIds!: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateReportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: ReportDatasetDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportDatasetDto)
  dataset?: ReportDatasetDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cronExpr?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  channelIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
