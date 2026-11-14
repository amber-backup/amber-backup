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
import { ProxmoxRestoreSpecDto } from '../../proxmox/dto/proxmox.dto';

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

  @ApiPropertyOptional({
    type: ProxmoxRestoreSpecDto,
    description: 'proxmox mode: which guest, onto which node, and how (or files into a container)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProxmoxRestoreSpecDto)
  proxmox?: ProxmoxRestoreSpecDto;
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
    enum: ['original', 'alternate_path', 'download', 'hyperv', 'proxmox'],
    description:
      'hyperv: register a backed-up VM (or restore its disks) on a Hyper-V host; proxmox: restore a guest (or files into a container) on a PVE node',
  })
  @IsIn(['original', 'alternate_path', 'download', 'hyperv', 'proxmox'])
  mode!: 'original' | 'alternate_path' | 'download' | 'hyperv' | 'proxmox';

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
