import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  imports: [JobsModule],
  controllers: [RunsController],
  providers: [RunsService],
})
export class RunsModule {}
