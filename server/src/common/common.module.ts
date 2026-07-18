import { Global, Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service';
import { SlugResolverService } from './slug-resolver.service';

/** Cross-cutting providers shared by all feature modules. */
@Global()
@Module({
  providers: [AccessControlService, SlugResolverService],
  exports: [AccessControlService, SlugResolverService],
})
export class CommonModule {}
