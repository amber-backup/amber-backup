import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { RestoreOptions } from '../../database/database.types';

export class CreateRestoreDto {
  @ApiProperty({ description: 'Job whose repository to restore from' })
  @IsUUID()
  jobId!: string;

  @ApiProperty()
  @IsString()
  snapshotId!: string;

  @ApiPropertyOptional({ type: [String], description: 'Selective restore paths' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  includedPaths?: string[];

  @ApiProperty({ enum: ['original', 'alternate_path', 'download'] })
  @IsIn(['original', 'alternate_path', 'download'])
  mode!: 'original' | 'alternate_path' | 'download';

  @ApiPropertyOptional({
    description: 'Destination: { path } or { agentId, path } for original/alternate',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  destination?: { path?: string; agentId?: string };

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  options?: RestoreOptions;
}
