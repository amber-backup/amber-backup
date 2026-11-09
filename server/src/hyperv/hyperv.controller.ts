import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAdminApiKey, RequireAdmin } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { SlugResolverService } from '../common/slug-resolver.service';
import { HypervService } from './hyperv.service';
import { CreateHypervHostDto, UpdateHypervHostDto, VM_ID_RE } from './dto/hyperv.dto';

/**
 * Hyper-V hosts. Like agents, hosts are an admin concern: they decide which
 * VMs of which machine Amber can read and register.
 */
@ApiTags('hyperv')
@RequireAdmin()
@AllowAdminApiKey()
@Controller('hyperv')
export class HypervController {
  constructor(
    private readonly hyperv: HypervService,
    private readonly slugs: SlugResolverService,
  ) {}

  @Get('hosts')
  @ApiOperation({ summary: 'List Hyper-V hosts' })
  list() {
    return this.hyperv.list();
  }

  @Post('hosts')
  @ApiOperation({ summary: 'Add a Hyper-V host (local agent or remote via a proxy agent)' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateHypervHostDto) {
    return this.hyperv.create(user, dto);
  }

  @Get('hosts/:idOrSlug')
  @ApiOperation({ summary: 'A Hyper-V host with its VM inventory and protection' })
  async get(@Param('idOrSlug') idOrSlug: string) {
    return this.hyperv.get(await this.slugs.resolve('hyperv_hosts', idOrSlug));
  }

  @Patch('hosts/:idOrSlug')
  @ApiOperation({ summary: 'Update a Hyper-V host' })
  async update(@Param('idOrSlug') idOrSlug: string, @Body() dto: UpdateHypervHostDto) {
    return this.hyperv.update(await this.slugs.resolve('hyperv_hosts', idOrSlug), dto);
  }

  @Delete('hosts/:idOrSlug')
  @ApiOperation({ summary: 'Remove a Hyper-V host (no job may back it up anymore)' })
  async remove(@Param('idOrSlug') idOrSlug: string): Promise<void> {
    await this.hyperv.remove(await this.slugs.resolve('hyperv_hosts', idOrSlug));
  }

  @Post('hosts/:idOrSlug/refresh')
  @ApiOperation({ summary: "Ask the host's agent for a fresh VM inventory" })
  async refresh(@Param('idOrSlug') idOrSlug: string) {
    return this.hyperv.requestInventory(await this.slugs.resolve('hyperv_hosts', idOrSlug));
  }

  @Get('vms/:vmId/snapshots')
  @ApiOperation({ summary: 'Snapshots of a VM across all Hyper-V jobs, newest first' })
  vmSnapshots(@CurrentUser() user: RequestUser, @Param('vmId') vmId: string) {
    if (!VM_ID_RE.test(vmId)) throw new BadRequestException('vmId must be a GUID');
    return this.hyperv.vmSnapshots(user, vmId);
  }
}
