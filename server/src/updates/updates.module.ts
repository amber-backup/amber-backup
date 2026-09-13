import { Module } from '@nestjs/common';
import { UpdateCheckService } from './update-check.service';
import { UpdatesController } from './updates.controller';

/** Periodic lookup of the newest release for the UI's upgrade hint. */
@Module({
  controllers: [UpdatesController],
  providers: [UpdateCheckService],
})
export class UpdatesModule {}
