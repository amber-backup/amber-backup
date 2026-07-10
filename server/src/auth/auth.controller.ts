import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { loadConfig } from '../config/configuration';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { SESSION_COOKIE } from '../common/guards/auth.guard';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { UsersService } from './users.service';
import { LoginDto } from './dto/auth.dto';

const OIDC_STATE_COOKIE = 'amber_oidc';

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: loadConfig().cookieSecure,
    path: '/',
    maxAge: 7 * 86400_000,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sso: SsoService,
    private readonly users: UsersService,
  ) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Local email/password login' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password);
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
    return { user: result.user, token: result.token };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Clear the session cookie' })
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @ApiOperation({ summary: 'Current authenticated user' })
  async me(@CurrentUser() user: RequestUser) {
    return this.users.findById(user.id);
  }

  @Public()
  @Get('providers')
  @ApiOperation({ summary: 'Enabled SSO providers' })
  providers() {
    return this.sso.listProviders();
  }

  @Public()
  @Get('oidc/:provider')
  @ApiOperation({ summary: 'Start an SSO login' })
  async startSso(@Param('provider') provider: string, @Res() res: Response) {
    const { authUrl, stateCookie } = await this.sso.startLogin(provider);
    res.cookie(OIDC_STATE_COOKIE, stateCookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: loadConfig().cookieSecure,
      path: '/',
      maxAge: 10 * 60_000,
    });
    res.redirect(authUrl);
  }

  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'SSO redirect callback' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const stateCookie = (
      req as Request & { cookies?: Record<string, string> }
    ).cookies?.[OIDC_STATE_COOKIE];
    const result = await this.sso.handleCallback(code, state, stateCookie);
    res.clearCookie(OIDC_STATE_COOKIE, { path: '/' });

    if (result.userDisabled) {
      res.redirect('/?sso=pending');
      return;
    }
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
    res.redirect('/');
  }
}
