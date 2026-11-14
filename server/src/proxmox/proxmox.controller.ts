import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAdminApiKey, RequireAdmin } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { SlugResolverService } from '../common/slug-resolver.service';
import { ProxmoxService } from './proxmox.service';
import { CreateProxmoxClusterDto, UpdateProxmoxClusterDto } from './dto/proxmox.dto';

/**
 * Proxmox VE clusters. Like Hyper-V hosts, an admin concern: they decide which
 * guests of which cluster Amber can read and restore.
 */
@ApiTags('proxmox')
@RequireAdmin()
@AllowAdminApiKey()
@Controller('proxmox')
export class ProxmoxController {
  constructor(
    private readonly proxmox: ProxmoxService,
    private readonly slugs: SlugResolverService,
  ) {}

  @Get('clusters')
  @ApiOperation({ summary: 'List Proxmox clusters' })
  list() {
    return this.proxmox.list();
  }

  @Get('summary')
  @ApiOperation({ summary: 'Guests without a job, failed guests and nodes without an agent' })
  summary() {
    return this.proxmox.summary();
  }

  @Get('candidates')
  @ApiOperation({ summary: 'Agents running on PVE nodes (to add a cluster)' })
  candidates() {
    return this.proxmox.candidates();
  }

  @Post('clusters')
  @ApiOperation({ summary: 'Add a Proxmox cluster through one of its node agents' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateProxmoxClusterDto) {
    return this.proxmox.create(user, dto);
  }

  @Get('clusters/:idOrSlug')
  @ApiOperation({ summary: 'A cluster with its inventory, nodes and guest protection' })
  async get(@Param('idOrSlug') idOrSlug: string) {
    return this.proxmox.get(await this.slugs.resolve('proxmox_clusters', idOrSlug));
  }

  @Patch('clusters/:idOrSlug')
  @ApiOperation({ summary: 'Rename a cluster or change its primary agent' })
  async update(@Param('idOrSlug') idOrSlug: string, @Body() dto: UpdateProxmoxClusterDto) {
    return this.proxmox.update(await this.slugs.resolve('proxmox_clusters', idOrSlug), dto);
  }

  @Delete('clusters/:idOrSlug')
  @ApiOperation({ summary: 'Remove a cluster (no job may back it up anymore)' })
  async remove(@Param('idOrSlug') idOrSlug: string): Promise<void> {
    await this.proxmox.remove(await this.slugs.resolve('proxmox_clusters', idOrSlug));
  }

  @Post('clusters/:idOrSlug/refresh')
  @ApiOperation({ summary: 'Ask a node agent for a fresh inventory' })
  async refresh(@Param('idOrSlug') idOrSlug: string) {
    return this.proxmox.requestInventory(await this.slugs.resolve('proxmox_clusters', idOrSlug));
  }

  @Get('clusters/:idOrSlug/guests/:vmid/snapshots')
  @ApiOperation({ summary: "Snapshots of a guest across the cluster's jobs, newest first" })
  async guestSnapshots(
    @CurrentUser() user: RequestUser,
    @Param('idOrSlug') idOrSlug: string,
    @Param('vmid', ParseIntPipe) vmid: number,
  ) {
    return this.proxmox.guestSnapshots(
      user,
      await this.slugs.resolve('proxmox_clusters', idOrSlug),
      vmid,
    );
  }

  @Get('runs/:runId/items')
  @ApiOperation({ summary: 'Per-guest rows of a Proxmox backup run' })
  runItems(@CurrentUser() user: RequestUser, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.proxmox.runItems(user, runId);
  }
}
