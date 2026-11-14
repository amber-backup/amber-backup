import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { truncateMiddle } from '../../common/truncate';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type {
  ProxmoxCbtState,
  ProxmoxGuestType,
  ProxmoxMethod,
  ProxmoxMethodChoice,
  ProxmoxVzdumpMode,
} from '../proxmox.contract';

/** PVE node names are host names. */
export const PVE_NODE_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})$/;
/** Hex digest the agents announce as the cluster id. */
export const PVE_CLUSTER_ID_RE = /^[0-9a-f]{16,128}$/;
/** PVE storage ids, pool names and tags: letters, digits and a few separators. */
export const PVE_IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;
/** PVE allows VMIDs from 100 to 999999999. */
export const VMID_MIN = 100;
export const VMID_MAX = 999_999_999;

const GUEST_TYPES: ProxmoxGuestType[] = ['qemu', 'lxc'];
const METHODS: ProxmoxMethod[] = ['vzdump', 'block', 'files'];
const METHOD_CHOICES: ProxmoxMethodChoice[] = ['auto', 'vzdump'];
const VZDUMP_MODES: ProxmoxVzdumpMode[] = ['snapshot', 'suspend', 'stop'];

// --- Clusters -------------------------------------------------------------------

export class CreateProxmoxClusterDto {
  @ApiProperty({ example: 'pve-prod' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiProperty({
    description:
      'An agent on one of the PVE nodes (GET /proxmox/candidates); it reads the inventory and runs retention',
  })
  @IsUUID()
  primaryAgentId!: string;
}

export class UpdateProxmoxClusterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @ApiPropertyOptional({ description: 'Another node agent of the same cluster; the jobs follow' })
  @IsOptional()
  @IsUUID()
  primaryAgentId?: string;
}

// --- Poll announcement -------------------------------------------------------------

export class ProxmoxAgentInfoDto {
  @ApiProperty({ description: 'sha256 hex of /etc/pve/pve-root-ca.pem' })
  @Matches(PVE_CLUSTER_ID_RE)
  clusterId!: string;

  @ApiPropertyOptional({ nullable: true, description: 'corosync cluster name; null when standalone' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  clusterName!: string | null;

  @ApiProperty()
  @Matches(PVE_NODE_RE)
  node!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(256)
  pveVersion!: string;
}

// --- Inventory reported by the agent --------------------------------------------------

export class ProxmoxGuestDiskDto {
  @IsString() @MaxLength(32) key!: string;
  @IsString() @MaxLength(512) volid!: string;
  @IsString() @MaxLength(128) storage!: string;
  @IsNumber() @Min(0) sizeBytes!: number;
  @IsOptional() @IsString() @MaxLength(32) format?: string;
  @IsBoolean() backup!: boolean;
}

export class ProxmoxGuestDto {
  @IsInt() @Min(VMID_MIN) @Max(VMID_MAX) vmid!: number;
  @IsIn(GUEST_TYPES) type!: ProxmoxGuestType;
  @IsString() @MaxLength(256) name!: string;
  @Matches(PVE_NODE_RE) node!: string;
  @IsString() @MaxLength(32) status!: string;
  @IsBoolean() template!: boolean;
  @IsOptional() @IsString() @MaxLength(64) lock?: string;
  @IsOptional() @IsString() @MaxLength(64) haState?: string;
  @IsOptional() @IsString() @MaxLength(128) pool?: string;

  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  tags!: string[];

  @IsOptional() @IsBoolean() guestAgent?: boolean;
  @IsOptional() @IsBoolean() unprivileged?: boolean;
  @IsOptional() @IsInt() @Min(0) cores?: number;
  @IsOptional() @IsNumber() @Min(0) memoryBytes?: number;

  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => ProxmoxGuestDiskDto)
  disks!: ProxmoxGuestDiskDto[];

  @IsIn(METHODS) autoMethod!: ProxmoxMethod;
  @IsOptional() @IsString() @MaxLength(1024) autoMethodReason?: string;

  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  staleSnapshots!: string[];
}

export class ProxmoxStorageDto {
  @IsString() @MaxLength(128) id!: string;
  @IsString() @MaxLength(32) type!: string;
  @IsBoolean() shared!: boolean;

  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  content!: string[];

  @IsArray()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  nodes!: string[];

  @IsBoolean() snapshots!: boolean;
  @IsOptional() @IsNumber() @Min(0) availBytes?: number;
  @IsOptional() @IsNumber() @Min(0) totalBytes?: number;
}

export class ProxmoxNodeInfoDto {
  @Matches(PVE_NODE_RE) name!: string;
  @IsBoolean() online!: boolean;
}

export class ProxmoxInventoryDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  clusterName!: string | null;

  @ApiProperty() @IsString() @MaxLength(256) pveVersion!: string;
  @ApiProperty() @Matches(PVE_NODE_RE) readBy!: string;

  @ApiProperty({ type: [ProxmoxNodeInfoDto] })
  @IsArray()
  @ArrayMaxSize(256)
  @ValidateNested({ each: true })
  @Type(() => ProxmoxNodeInfoDto)
  nodes!: ProxmoxNodeInfoDto[];

  @ApiProperty({ type: [ProxmoxStorageDto] })
  @IsArray()
  @ArrayMaxSize(1024)
  @ValidateNested({ each: true })
  @Type(() => ProxmoxStorageDto)
  storages!: ProxmoxStorageDto[];

  @ApiProperty({ type: [ProxmoxGuestDto] })
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => ProxmoxGuestDto)
  guests!: ProxmoxGuestDto[];
}

// --- One guest's backup outcome -----------------------------------------------------

export class ProxmoxGuestResultDto {
  @IsInt() @Min(VMID_MIN) @Max(VMID_MAX) vmid!: number;
  @IsIn(GUEST_TYPES) type!: ProxmoxGuestType;
  @IsString() @MaxLength(256) name!: string;
  /** Informational; may be empty when the agent could not tell. */
  @IsString() @MaxLength(64) node!: string;
  @IsIn(['success', 'failed', 'moved', 'skipped']) status!: 'success' | 'failed' | 'moved' | 'skipped';
  @IsOptional() @Matches(PVE_NODE_RE) movedTo?: string;
  @IsOptional() @IsIn(METHODS) method?: ProxmoxMethod;
  @IsOptional() @IsIn(['application', 'crash', 'offline']) consistency?: 'application' | 'crash' | 'offline';
  @IsOptional() @IsIn(['incremental', 'full']) cbt?: 'incremental' | 'full';
  @IsOptional() @IsString() @MaxLength(1024) cbtReason?: string;

  /** Owned by the agent: stored as is and handed back with the next backup. */
  @IsOptional() @IsObject() nextCbt?: ProxmoxCbtState | null;

  @IsOptional() @IsString() @MaxLength(128) snapshotId?: string;
  @IsOptional() @IsNumber() @Min(0) dataAdded?: number;
  @IsOptional() @IsNumber() @Min(0) bytesRead?: number;
  @IsOptional() @IsNumber() @Min(0) totalBytes?: number;
  @IsOptional() @IsNumber() @Min(0) durationSeconds?: number;
  // Shortened rather than rejected: the guest's outcome must not be lost to a long error.
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? truncateMiddle(value, 20_000) : value))
  @MaxLength(20_000)
  error?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  warnings?: string[];
}

// --- Job & restore parts --------------------------------------------------------------

export class ProxmoxJobConfigDto {
  @ApiProperty({ description: 'Back up every guest of the cluster, including future ones' })
  @IsBoolean()
  allGuests!: boolean;

  @ApiProperty({ type: [Number], description: 'Explicit VMIDs when allGuests is false' })
  @IsArray()
  @ArrayMaxSize(4096)
  @IsInt({ each: true })
  @Min(VMID_MIN, { each: true })
  @Max(VMID_MAX, { each: true })
  vmids!: number[];

  @ApiPropertyOptional({ type: [String], description: 'Also every guest of these PVE pools' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @Matches(PVE_IDENT_RE, { each: true })
  pools?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Also every guest with one of these PVE tags' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(256)
  @Matches(PVE_IDENT_RE, { each: true })
  pveTags?: string[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4096)
  @IsInt({ each: true })
  @Min(VMID_MIN, { each: true })
  @Max(VMID_MAX, { each: true })
  excludeVmids?: number[];

  @ApiPropertyOptional({ enum: GUEST_TYPES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(GUEST_TYPES, { each: true })
  types?: ProxmoxGuestType[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeTemplates?: boolean;

  @ApiPropertyOptional({ enum: METHOD_CHOICES, default: 'auto' })
  @IsOptional()
  @IsIn(METHOD_CHOICES)
  vmMethod?: ProxmoxMethodChoice;

  @ApiPropertyOptional({ enum: METHOD_CHOICES, default: 'auto' })
  @IsOptional()
  @IsIn(METHOD_CHOICES)
  ctMethod?: ProxmoxMethodChoice;

  @ApiPropertyOptional({ enum: VZDUMP_MODES, default: 'snapshot' })
  @IsOptional()
  @IsIn(VZDUMP_MODES)
  vzdumpMode?: ProxmoxVzdumpMode;

  @ApiPropertyOptional({ description: 'Fail a running VM without guest agent instead of a crash-consistent backup' })
  @IsOptional()
  @IsBoolean()
  requireConsistent?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 4, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  parallelPerNode?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 64, description: 'Cluster-wide cap (default unlimited)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  maxParallel?: number;
}

export class ProxmoxRestoreSpecDto {
  @ApiProperty() @IsUUID() clusterId!: string;

  @ApiProperty({ description: 'Guest the snapshot belongs to' })
  @IsInt()
  @Min(VMID_MIN)
  @Max(VMID_MAX)
  vmid!: number;

  @ApiProperty({ enum: GUEST_TYPES }) @IsIn(GUEST_TYPES) guestType!: ProxmoxGuestType;

  @ApiProperty({
    enum: ['guest', 'files', 'vm-files'],
    description: 'guest: whole guest; files: files into a container; vm-files: files of a VM backup to targetPath',
  })
  @IsIn(['guest', 'files', 'vm-files'])
  action!: 'guest' | 'files' | 'vm-files';

  @ApiProperty({ description: 'Node whose agent runs the restore' })
  @Matches(PVE_NODE_RE, { message: 'targetNode must be a PVE node name' })
  targetNode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(VMID_MIN)
  @Max(VMID_MAX)
  newVmid?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() replaceOriginal?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(PVE_IDENT_RE, { message: 'storage must be a PVE storage id' })
  storage?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() unique?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  @Matches(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, { message: 'name must be a valid DNS name' })
  name?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() start?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(10_000_000) bwlimitKiB?: number;

  @ApiPropertyOptional({ description: 'files: container that receives the files (default vmid)' })
  @IsOptional()
  @IsInt()
  @Min(VMID_MIN)
  @Max(VMID_MAX)
  targetVmid?: number;

  @ApiPropertyOptional({
    description: 'guest (block snapshots of VMs): start the VM from the backup and move its disks while it runs',
  })
  @IsOptional()
  @IsBoolean()
  liveRestore?: boolean;

  @ApiPropertyOptional({ description: 'Live restore: dir/NFS/CIFS storage for the temporary qcow2 overlays' })
  @IsOptional()
  @Matches(PVE_IDENT_RE, { message: 'overlayStorage must be a PVE storage id' })
  overlayStorage?: string;

  @ApiPropertyOptional({ description: 'vm-files: absolute directory on the target node (not /)' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  @Matches(/^\/[^\0]*$/, { message: 'targetPath must be an absolute path' })
  targetPath?: string;
}
