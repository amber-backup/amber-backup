import { Module } from '@nestjs/common';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';
import { SshKeyService } from './ssh-key.service';

@Module({
  controllers: [TargetsController],
  providers: [TargetsService, SshKeyService],
  exports: [TargetsService],
})
export class TargetsModule {}
