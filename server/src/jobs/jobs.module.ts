import { Module } from '@nestjs/common';
import { TargetsModule } from '../targets/targets.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobRunnerService } from './job-runner.service';
import { PruneRunnerService } from './prune-runner.service';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [TargetsModule, NotificationsModule, RepositoriesModule],
  controllers: [JobsController],
  providers: [JobsService, JobRunnerService, PruneRunnerService, SchedulerService],
  exports: [JobsService, JobRunnerService, PruneRunnerService, SchedulerService],
})
export class JobsModule {}
