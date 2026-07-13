import { Module } from '@nestjs/common';
import { TargetsModule } from '../targets/targets.module';
import { JobsModule } from '../jobs/jobs.module';
import { SnapshotsService } from './snapshots.service';
import { SnapshotsController } from './snapshots.controller';
import { RestoreService } from './restore.service';
import { RestoreController } from './restore.controller';
import { RestoreRunnerService } from './restore-runner.service';

@Module({
  imports: [TargetsModule, JobsModule],
  controllers: [SnapshotsController, RestoreController],
  providers: [SnapshotsService, RestoreService, RestoreRunnerService],
  exports: [RestoreRunnerService],
})
export class RestoreModule {}
