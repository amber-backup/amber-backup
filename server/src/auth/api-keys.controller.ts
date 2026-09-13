import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoApiKey } from '../common/decorators/public.decorator';
import { RequestUser } from '../common/auth/request-user';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/auth.dto';

@ApiTags('api-keys')
@Controller('api-keys')
// A key can never create, list or revoke keys — that would let a leaked,
// narrowly-scoped key escalate to a full-power one. Session auth only.
@NoApiKey()
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @ApiOperation({ summary: 'List own API keys' })
  list(@CurrentUser() user: RequestUser) {
    return this.apiKeys.list(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Create an API key (plaintext shown once)' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateApiKeyDto) {
    return this.apiKeys.create(user.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke an API key' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.apiKeys.remove(user.id, id);
    return { ok: true };
  }
}
