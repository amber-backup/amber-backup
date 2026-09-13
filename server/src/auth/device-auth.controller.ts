import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import {
  AnyApiKeyScope,
  NoApiKey,
  Public,
} from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { clientIp } from '../audit/audit.util';
import { DeviceAuthService, DeviceRequestContext } from './device-auth.service';
import {
  DeviceApproveDto,
  DeviceCodeRequestDto,
  DeviceCodeResponseDto,
  DeviceRequestInfoDto,
  DeviceTokenRequestDto,
  DeviceTokenResponseDto,
  DeviceUserCodeDto,
} from './dto/device-auth.dto';

function requestContext(req: Request): DeviceRequestContext {
  return {
    ip: clientIp(req),
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * Device pairing for the CLI (`ambb login`). The code and token endpoints are
 * public but rate-limited; everything that decides a pairing needs an
 * interactive session — an API key can never approve the minting of another.
 */
@ApiTags('auth')
@Controller('auth/device')
export class DeviceAuthController {
  constructor(private readonly deviceAuth: DeviceAuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @Post('code')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a CLI device pairing' })
  @ApiOkResponse({ type: DeviceCodeResponseDto })
  requestCode(
    @Body() dto: DeviceCodeRequestDto,
    @Req() req: Request,
  ): Promise<DeviceCodeResponseDto> {
    return this.deviceAuth.requestCode(dto.clientName, requestContext(req));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @Post('token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Poll a device pairing; returns the API key once approved' })
  @ApiOkResponse({ type: DeviceTokenResponseDto })
  token(
    @Body() dto: DeviceTokenRequestDto,
    @Req() req: Request,
  ): Promise<DeviceTokenResponseDto> {
    return this.deviceAuth.exchange(dto.deviceCode, requestContext(req));
  }

  @NoApiKey()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @Get('requests/:userCode')
  @ApiOperation({ summary: 'Show a pending device pairing for approval' })
  @ApiOkResponse({ type: DeviceRequestInfoDto })
  lookup(@Param('userCode') userCode: string): Promise<DeviceRequestInfoDto> {
    return this.deviceAuth.lookup(userCode);
  }

  @NoApiKey()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @Post('approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a device pairing for the signed-in user' })
  async approve(
    @CurrentUser() user: RequestUser,
    @Body() dto: DeviceApproveDto,
  ): Promise<{ ok: true }> {
    await this.deviceAuth.approve(user, dto);
    return { ok: true };
  }

  @NoApiKey()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseGuards(ThrottlerGuard)
  @Post('deny')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a device pairing' })
  async deny(
    @CurrentUser() user: RequestUser,
    @Body() dto: DeviceUserCodeDto,
  ): Promise<{ ok: true }> {
    await this.deviceAuth.deny(user, dto.userCode);
    return { ok: true };
  }

  // A key revoking itself grants nothing, so even a read-only key may log out.
  @AnyApiKeyScope()
  @Delete('key')
  @ApiOperation({ summary: 'Revoke the API key making this request (CLI logout)' })
  async revokeCurrentKey(@CurrentUser() user: RequestUser): Promise<{ ok: true }> {
    await this.deviceAuth.revokeCurrentKey(user);
    return { ok: true };
  }
}
