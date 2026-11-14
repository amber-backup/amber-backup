import { Module } from '@nestjs/common';
import { TargetsModule } from '../targets/targets.module';
import { JobsModule } from '../jobs/jobs.module';
import { HypervController } from './hyperv.controller';
import { HypervService } from './hyperv.service';

@Module({
  imports: [TargetsModule, JobsModule],
  controllers: [HypervController],
  providers: [HypervService],
  exports: [HypervService],
})
export class HypervModule {}
