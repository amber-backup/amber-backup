import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { CryptoModule } from './crypto/crypto.module';
import { CommonModule } from './common/common.module';
import { ResticModule } from './restic/restic.module';
import { AuthModule } from './auth/auth.module';
import { TargetsModule } from './targets/targets.module';
import { JobsModule } from './jobs/jobs.module';
import { RunsModule } from './runs/runs.module';
import { RestoreModule } from './restore/restore.module';
import { AgentsModule } from './agents/agents.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SettingsModule } from './settings/settings.module';
import { StaticModule } from './static.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    CryptoModule,
    CommonModule,
    ResticModule,
    AuthModule,
    TargetsModule,
    JobsModule,
    RunsModule,
    RestoreModule,
    AgentsModule,
    NotificationsModule,
    SettingsModule,
    StaticModule,
  ],
})
export class AppModule {}
