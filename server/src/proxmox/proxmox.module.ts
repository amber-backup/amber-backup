import { Module } from '@nestjs/common';
import { TargetsModule } from '../targets/targets.module';
import { JobsModule } from '../jobs/jobs.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { ProxmoxController } from './proxmox.controller';
import { ProxmoxService } from './proxmox.service';

@Module({
  imports: [TargetsModule, JobsModule, RepositoriesModule],
  controllers: [ProxmoxController],
  providers: [ProxmoxService],
  exports: [ProxmoxService],
})
export class ProxmoxModule {}
