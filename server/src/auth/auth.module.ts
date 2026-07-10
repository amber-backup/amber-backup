import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { loadConfig } from '../config/configuration';
import { AuthGuard } from '../common/guards/auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { SsoService } from './sso.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: loadConfig().jwtSecret,
    }),
  ],
  controllers: [AuthController, UsersController, ApiKeysController],
  providers: [
    AuthService,
    UsersService,
    ApiKeysService,
    SsoService,
    // Global authentication guard (respects @Public).
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [UsersService, AuthService],
})
export class AuthModule {}
