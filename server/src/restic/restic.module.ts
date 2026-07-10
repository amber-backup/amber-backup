import { Global, Module } from '@nestjs/common';
import { ResticService } from './restic.service';

@Global()
@Module({
  providers: [ResticService],
  exports: [ResticService],
})
export class ResticModule {}
