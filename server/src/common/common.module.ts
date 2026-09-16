import { Global, Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service';
import { AdminIpAllowlistService } from './admin-ip-allowlist.service';
import { SlugResolverService } from './slug-resolver.service';

/** Cross-cutting providers shared by all feature modules. */
@Global()
@Module({
  providers: [AccessControlService, SlugResolverService, AdminIpAllowlistService],
  exports: [AccessControlService, SlugResolverService, AdminIpAllowlistService],
})
export class CommonModule {}
