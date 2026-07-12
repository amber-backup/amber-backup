import {
  Body,
  Controller,
  Delete,
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
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { SsoService } from './sso.service';
import { UsersService } from './users.service';
import { TotpService } from './totp.service';
import { PasskeysService } from './passkeys.service';
import {
  ChangePasswordDto,
  DisableTotpDto,
  EnableTotpDto,
  LoginDto,
  LoginTotpDto,
  PasskeyLoginDto,
  PasskeyRegisterDto,
} from './dto/auth.dto';

/** Best-effort client IP for audit entries. */
function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

const OIDC_STATE_COOKIE = 'amber_oidc';
const WEBAUTHN_REG_COOKIE = 'amber_wa_reg';
const WEBAUTHN_AUTH_COOKIE = 'amber_wa_auth';

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: loadConfig().cookieSecure,
    path: '/',
    maxAge: 7 * 86400_000,
  };
}

/** Short-lived cookie carrying a signed WebAuthn ceremony challenge. */
function challengeCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: loadConfig().cookieSecure,
    path: '/',
    maxAge: 5 * 60_000,
  };
}

function readCookie(req: Request, name: string): string | undefined {
  return (req as Request & { cookies?: Record<string, string> }).cookies?.[name];
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sso: SsoService,
    private readonly users: UsersService,
    private readonly totp: TotpService,
    private readonly passkeys: PasskeysService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Local email/password login' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req);
    const userAgent = (req.headers['user-agent'] as string) ?? null;
    try {
      const result = await this.auth.login(dto.email, dto.password);
      // Password verified but a second factor is required: hand back a
      // short-lived challenge token and set no session cookie yet.
      if (result.status === '2fa_required') {
        return { totpRequired: true, challengeToken: result.challengeToken };
      }
      res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
      void this.audit.record({
        actorId: result.user.id,
        actorEmail: result.user.email,
        actorType: 'session',
        actorIsAdmin: result.user.is_admin,
        action: 'Log in',
        method: 'POST',
        path: '/api/auth/login',
        resourceType: 'auth',
        statusCode: 200,
        outcome: 'success',
        ip,
        userAgent,
      });
      return { user: result.user, token: result.token };
    } catch (err) {
      void this.audit.record({
        actorEmail: dto.email,
        actorType: 'session',
        action: 'Failed login',
        method: 'POST',
        path: '/api/auth/login',
        resourceType: 'auth',
        statusCode: (err as { status?: number } | null)?.status ?? 401,
        outcome: 'failure',
        ip,
        userAgent,
        details: { email: dto.email },
      });
      throw err;
    }
  }

  @Public()
  @Post('login/totp')
  @ApiOperation({ summary: 'Complete a 2FA login with a TOTP or recovery code' })
  async loginTotp(
    @Body() dto: LoginTotpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req);
    const userAgent = (req.headers['user-agent'] as string) ?? null;
    try {
      const result = await this.auth.loginTotp(dto.challengeToken, dto.code);
      res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
      void this.audit.record({
        actorId: result.user.id,
        actorEmail: result.user.email,
        actorType: 'session',
        actorIsAdmin: result.user.is_admin,
        action: 'Log in',
        method: 'POST',
        path: '/api/auth/login/totp',
        resourceType: 'auth',
        statusCode: 200,
        outcome: 'success',
        ip,
        userAgent,
      });
      return { user: result.user, token: result.token };
    } catch (err) {
      void this.audit.record({
        actorType: 'session',
        action: 'Failed 2FA login',
        method: 'POST',
        path: '/api/auth/login/totp',
        resourceType: 'auth',
        statusCode: (err as { status?: number } | null)?.status ?? 401,
        outcome: 'failure',
        ip,
        userAgent,
      });
      throw err;
    }
  }

  @Post('2fa/setup')
  @ApiOperation({ summary: 'Begin TOTP enrollment (returns QR + secret)' })
  setupTotp(@CurrentUser() user: RequestUser) {
    return this.totp.setup(user.id);
  }

  @Post('2fa/enable')
  @ApiOperation({ summary: 'Confirm a TOTP code and enable 2FA' })
  enableTotp(@CurrentUser() user: RequestUser, @Body() dto: EnableTotpDto) {
    return this.totp.enable(user.id, dto.code);
  }

  @Post('2fa/disable')
  @ApiOperation({ summary: 'Disable 2FA (requires the account password)' })
  async disableTotp(
    @CurrentUser() user: RequestUser,
    @Body() dto: DisableTotpDto,
  ) {
    await this.totp.disable(user.id, dto.password);
    return { ok: true };
  }

  // --- Passkeys (WebAuthn) --------------------------------------------------

  @Post('passkeys/register/options')
  @ApiOperation({ summary: 'Begin passkey registration (returns WebAuthn options)' })
  async passkeyRegisterOptions(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { options, challengeToken } = await this.passkeys.registrationOptions(
      user.id,
      user.email,
    );
    res.cookie(WEBAUTHN_REG_COOKIE, challengeToken, challengeCookieOptions());
    return options;
  }

  @Post('passkeys/register/verify')
  @ApiOperation({ summary: 'Finish passkey registration' })
  async passkeyRegisterVerify(
    @CurrentUser() user: RequestUser,
    @Body() dto: PasskeyRegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const passkey = await this.passkeys.verifyRegistration(
      user.id,
      readCookie(req, WEBAUTHN_REG_COOKIE),
      dto.response as never,
      dto.name,
    );
    res.clearCookie(WEBAUTHN_REG_COOKIE, { path: '/' });
    return passkey;
  }

  @Get('passkeys')
  @ApiOperation({ summary: 'List the current user’s passkeys' })
  passkeyList(@CurrentUser() user: RequestUser) {
    return this.passkeys.list(user.id);
  }

  @Delete('passkeys/:id')
  @ApiOperation({ summary: 'Remove a passkey' })
  async passkeyRemove(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    await this.passkeys.remove(user.id, id);
    return { ok: true };
  }

  @Public()
  @Post('passkeys/login/options')
  @ApiOperation({ summary: 'Begin a usernameless passkey login' })
  async passkeyLoginOptions(@Res({ passthrough: true }) res: Response) {
    const { options, challengeToken } =
      await this.passkeys.authenticationOptions();
    res.cookie(WEBAUTHN_AUTH_COOKIE, challengeToken, challengeCookieOptions());
    return options;
  }

  @Public()
  @Post('passkeys/login/verify')
  @ApiOperation({ summary: 'Complete a passkey login and start a session' })
  async passkeyLoginVerify(
    @Body() dto: PasskeyLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req);
    const userAgent = (req.headers['user-agent'] as string) ?? null;
    try {
      const { userId } = await this.passkeys.verifyAuthentication(
        readCookie(req, WEBAUTHN_AUTH_COOKIE),
        dto.response as never,
      );
      const result = await this.auth.issueForUser(userId);
      res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
      res.clearCookie(WEBAUTHN_AUTH_COOKIE, { path: '/' });
      void this.audit.record({
        actorId: result.user.id,
        actorEmail: result.user.email,
        actorType: 'session',
        actorIsAdmin: result.user.is_admin,
        action: 'Log in',
        method: 'POST',
        path: '/api/auth/passkeys/login/verify',
        resourceType: 'auth',
        statusCode: 200,
        outcome: 'success',
        ip,
        userAgent,
      });
      return { user: result.user, token: result.token };
    } catch (err) {
      void this.audit.record({
        actorType: 'session',
        action: 'Failed passkey login',
        method: 'POST',
        path: '/api/auth/passkeys/login/verify',
        resourceType: 'auth',
        statusCode: (err as { status?: number } | null)?.status ?? 401,
        outcome: 'failure',
        ip,
        userAgent,
      });
      throw err;
    }
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

  @Post('change-password')
  @ApiOperation({ summary: 'Change the current user password' })
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.users.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    return { ok: true };
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
