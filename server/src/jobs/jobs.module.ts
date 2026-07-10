import { Module } from '@nestjs/common';
import { TargetsModule } from '../targets/targets.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobRunnerService } from './job-runner.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [TargetsModule, NotificationsModule],
  controllers: [JobsController],
  providers: [JobsService, JobRunnerService, SchedulerService],
  exports: [JobsService, JobRunnerService, SchedulerService],
})
export class JobsModule {}
