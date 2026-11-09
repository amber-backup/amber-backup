import { Module } from '@nestjs/common';
import { TargetsModule } from '../targets/targets.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { HypervModule } from '../hyperv/hyperv.module';
import { JobsModule } from '../jobs/jobs.module';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';
import { AgentApiController } from './agent-api.controller';
import { AgentAuthGuard } from '../common/guards/agent-auth.guard';

@Module({
  imports: [TargetsModule, NotificationsModule, RepositoriesModule, JobsModule, HypervModule],
  controllers: [AgentsController, AgentApiController],
  providers: [AgentsService, AgentAuthGuard],
  exports: [AgentsService],
})
export class AgentsModule {}
