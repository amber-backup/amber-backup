import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { RestoreOptions } from '../../database/database.types';

export class RestoreDestinationDto {
  @ApiPropertyOptional({ description: 'Filesystem path for original/alternate restore' })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional({ description: 'Agent host to restore onto (admin only)' })
  @IsOptional()
  @IsUUID()
  agentId?: string;
}

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
    type: RestoreDestinationDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RestoreDestinationDto)
  destination?: RestoreDestinationDto;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  options?: RestoreOptions;
}
