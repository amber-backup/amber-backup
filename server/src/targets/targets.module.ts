import { Module } from '@nestjs/common';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';
import { TargetHealthService } from './target-health.service';
import { SshKeyService } from './ssh-key.service';

@Module({
  controllers: [TargetsController],
  providers: [TargetsService, TargetHealthService, SshKeyService],
  exports: [TargetsService],
})
export class TargetsModule {}
