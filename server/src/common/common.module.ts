import { Global, Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service';

/** Cross-cutting providers shared by all feature modules. */
@Global()
@Module({
  providers: [AccessControlService],
  exports: [AccessControlService],
})
export class CommonModule {}
