import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** A Hyper-V VM id: a GUID. */
export const VM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Host names / addresses handed to PowerShell remoting: DNS names, IPv4 and
 * bracket-free IPv6. Nothing that could be read as a PowerShell expression.
 */
export const HOST_ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,252}[A-Za-z0-9])?$/;

/** DOMAIN\user, user@domain or a local user name. */
export const HOST_USERNAME_RE = /^[^\s"'`$;|&<>]{1,256}$/;

export class CreateHypervHostDto {
  @ApiProperty({ example: 'hv-01' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiProperty({
    enum: ['local', 'remote', 'cluster'],
    description:
      'local: the agent runs on the Hyper-V host; remote: the agent proxies it; cluster: a failover cluster reached through its nodes',
  })
  @IsIn(['local', 'remote', 'cluster'])
  mode!: 'local' | 'remote' | 'cluster';

  @ApiProperty({ description: 'Windows agent on the host (local) or the proxy agent (remote)' })
  @IsUUID()
  agentId!: string;

  @ApiPropertyOptional({ description: 'remote: DNS name or address of the host; cluster: the cluster name' })
  @ValidateIf((o) => o.mode !== 'local')
  @IsString()
  @Matches(HOST_ADDRESS_RE, { message: 'address must be a host name or IP address' })
  address?: string;

  @ApiPropertyOptional({ description: 'remote: DOMAIN\\user or user@domain' })
  @ValidateIf((o) => o.mode !== 'local')
  @IsString()
  @Matches(HOST_USERNAME_RE, { message: 'username contains invalid characters' })
  username?: string;

  @ApiPropertyOptional({ description: 'remote: password (stored encrypted)' })
  @ValidateIf((o) => o.mode !== 'local')
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password?: string;
}

export class UpdateHypervHostDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({ description: 'Move the host to another agent; its jobs follow' })
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(HOST_ADDRESS_RE, { message: 'address must be a host name or IP address' })
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(HOST_USERNAME_RE, { message: 'username contains invalid characters' })
  username?: string;

  @ApiPropertyOptional({ description: 'New password; omit to keep the stored one' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password?: string;
}

// --- Inventory reported by the agent ----------------------------------------

export class HypervDiskDto {
  @IsString() @MaxLength(1024) path!: string;
  @IsString() @MaxLength(32) controllerType!: string;
  @IsInt() @Min(0) controllerNumber!: number;
  @IsInt() @Min(0) controllerLocation!: number;
  @IsNumber() @Min(0) fileSizeBytes!: number;
  @IsNumber() @Min(0) sizeBytes!: number;
}

export class HypervVmDto {
  @Matches(VM_ID_RE) id!: string;
  @IsString() @MaxLength(256) name!: string;
  @IsString() @MaxLength(64) state!: string;
  @IsInt() generation!: number;
  @IsString() @MaxLength(32) version!: string;
  @IsInt() @Min(0) processorCount!: number;
  @IsNumber() @Min(0) memoryStartupBytes!: number;
  @IsString() @MaxLength(32) checkpointType!: string;
  @IsBoolean() backupIntegration!: boolean;
  @IsString() @MaxLength(1024) configurationLocation!: string;

  @IsArray()
  @ArrayMaxSize(256)
  @ValidateNested({ each: true })
  @Type(() => HypervDiskDto)
  disks!: HypervDiskDto[];

  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  staleCheckpoints!: string[];

  @IsOptional() @IsString() @MaxLength(4096) notes?: string;
  @IsOptional() @IsString() @Matches(HOST_ADDRESS_RE) node?: string;
}

export class HypervInventoryDto {
  @ApiProperty() @IsString() @MaxLength(256) computerName!: string;
  @ApiProperty() @IsString() @MaxLength(256) os!: string;

  @ApiProperty({ type: [HypervVmDto] })
  @IsArray()
  @ArrayMaxSize(4096)
  @ValidateNested({ each: true })
  @Type(() => HypervVmDto)
  vms!: HypervVmDto[];
}

// --- Job & restore parts ------------------------------------------------------

export class HypervJobConfigDto {
  @ApiProperty({ description: 'Back up every VM of the host, including future ones' })
  @IsBoolean()
  allVms!: boolean;

  @ApiProperty({ type: [String], description: 'VM ids (GUIDs) when allVms is false' })
  @IsArray()
  @ArrayMaxSize(1024)
  @Matches(VM_ID_RE, { each: true, message: 'each vmId must be a GUID' })
  vmIds!: string[];

  @ApiPropertyOptional({ type: [String], description: 'VM ids to skip when allVms is true' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1024)
  @Matches(VM_ID_RE, { each: true, message: 'each excludeVmId must be a GUID' })
  excludeVmIds?: string[];

  @ApiPropertyOptional({ enum: ['Production', 'ProductionOnly'], default: 'Production' })
  @IsOptional()
  @IsIn(['Production', 'ProductionOnly'])
  checkpointMode?: 'Production' | 'ProductionOnly';

  @ApiPropertyOptional({ description: 'VMs backed up at the same time', minimum: 1, maximum: 4, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  parallelVms?: number;
}

export class HypervRestoreSpecDto {
  @ApiProperty({ description: 'Hyper-V host to restore onto' })
  @IsUUID()
  hostId!: string;

  @ApiProperty({ description: 'Id of the backed-up VM' })
  @Matches(VM_ID_RE, { message: 'vmId must be a GUID' })
  vmId!: string;

  @ApiProperty({ enum: ['vm', 'disks'] })
  @IsIn(['vm', 'disks'])
  action!: 'vm' | 'disks';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[^"'`$\\/:*?<>|]+$/, { message: 'newName contains characters a VM name cannot have' })
  newName?: string;

  @ApiPropertyOptional({ description: 'Stop and replace the original VM (keeps its id)' })
  @IsOptional()
  @IsBoolean()
  replaceOriginal?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  start?: boolean;

  @ApiPropertyOptional({ description: 'Keep network adapters connected (default: disconnected)' })
  @IsOptional()
  @IsBoolean()
  connectNetwork?: boolean;

  @ApiPropertyOptional({ description: 'Cluster hosts: node to register the VM on' })
  @IsOptional()
  @IsString()
  @Matches(HOST_ADDRESS_RE, { message: 'node must be a host name' })
  node?: string;
}
