import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAdmin } from '../common/decorators/public.decorator';
import { SettingsService } from './settings.service';
import { UpdateAgentSettingsDto, UpdateSsoDto } from './dto/settings.dto';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

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
  @Put('sso')
  @ApiOperation({ summary: 'Update SSO (OIDC / Entra) configuration' })
  async updateSso(@Body() dto: UpdateSsoDto) {
    await this.settings.updateSso(dto);
    return this.settings.getSystemView();
  }
}
