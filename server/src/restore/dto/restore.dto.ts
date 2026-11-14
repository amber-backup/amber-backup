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
import { HypervRestoreSpecDto } from '../../hyperv/dto/hyperv.dto';

export class RestoreDestinationDto {
  @ApiPropertyOptional({ description: 'Filesystem path for original/alternate restore' })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional({ description: 'Agent host to restore onto (admin only)' })
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({
    type: HypervRestoreSpecDto,
    description: 'hyperv mode: which VM, onto which host, and how',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => HypervRestoreSpecDto)
  hyperv?: HypervRestoreSpecDto;
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

  @ApiProperty({
    enum: ['original', 'alternate_path', 'download', 'hyperv'],
    description: 'hyperv: register a backed-up VM (or restore its disks) on a Hyper-V host',
  })
  @IsIn(['original', 'alternate_path', 'download', 'hyperv'])
  mode!: 'original' | 'alternate_path' | 'download' | 'hyperv';

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
