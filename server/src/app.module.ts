import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { CryptoModule } from './crypto/crypto.module';
import { CommonModule } from './common/common.module';
import { ResticModule } from './restic/restic.module';
import { AuthModule } from './auth/auth.module';
import { TargetsModule } from './targets/targets.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { JobsModule } from './jobs/jobs.module';
import { RunsModule } from './runs/runs.module';
import { RestoreModule } from './restore/restore.module';
import { AgentsModule } from './agents/agents.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { SettingsModule } from './settings/settings.module';
import { AuditModule } from './audit/audit.module';
import { StaticModule } from './static.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    // Rate-limit storage/config, available app-wide. ThrottlerGuard is applied
    // selectively (the sensitive auth endpoints) rather than globally, so agent
    // polling and normal API traffic are unaffected.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
    DatabaseModule,
    CryptoModule,
    CommonModule,
    ResticModule,
    AuthModule,
    TargetsModule,
    RepositoriesModule,
    JobsModule,
    RunsModule,
    RestoreModule,
    AgentsModule,
    NotificationsModule,
    ReportsModule,
    SettingsModule,
    AuditModule,
    StaticModule,
  ],
})
export class AppModule {}
