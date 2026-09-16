import { Body, Controller, Get, Patch, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAdmin } from '../common/decorators/public.decorator';
import { AdminIpAllowlistService } from '../common/admin-ip-allowlist.service';
import { SettingsService } from './settings.service';
import {
  UpdateAdminIpAllowlistDto,
  UpdateAgentSettingsDto,
  UpdateAuthSettingsDto,
  UpdateSsoDto,
} from './dto/settings.dto';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly adminIps: AdminIpAllowlistService,
  ) {}

  @RequireAdmin()
  @Get('system')
  @ApiOperation({ summary: 'System settings (agent timeout, SSO — admin)' })
  system() {
    return this.settings.getSystemView();
  }

  @RequireAdmin()
  @Patch('agents')
  @ApiOperation({ summary: 'Update agent-related settings' })
  async updateAgents(@Body() dto: UpdateAgentSettingsDto) {
    await this.settings.setAgentOfflineTimeout(dto.offlineTimeoutSeconds);
    return this.settings.getSystemView();
  }

  @RequireAdmin()
  @Patch('auth')
  @ApiOperation({ summary: 'Enable or disable password and passkey logins' })
  async updateAuth(@Body() dto: UpdateAuthSettingsDto) {
    await this.settings.setLocalLoginEnabled(dto.localLoginEnabled);
    return this.settings.getSystemView();
  }

  @RequireAdmin()
  @Put('sso')
  @ApiOperation({ summary: 'Update SSO (OIDC / Entra) configuration' })
  async updateSso(@Body() dto: UpdateSsoDto) {
    await this.settings.updateSso(dto);
    return this.settings.getSystemView();
  }

  @RequireAdmin()
  @Get('admin-ip-allowlist')
  @ApiOperation({ summary: 'Addresses administrators may connect from (admin)' })
  adminIpAllowlist(@Req() req: Request) {
    return this.adminIps.view(req.ip);
  }

  @RequireAdmin()
  @Put('admin-ip-allowlist')
  @ApiOperation({
    summary: 'Replace the UI-maintained admin IP allowlist (must keep the caller allowed)',
  })
  updateAdminIpAllowlist(
    @Req() req: Request,
    @Body() dto: UpdateAdminIpAllowlistDto,
  ) {
    return this.adminIps.update(dto.entries, req.ip);
  }
}
