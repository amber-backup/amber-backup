import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { SecretsService } from './secrets.service';

@Global()
@Module({
  providers: [CryptoService, SecretsService],
  exports: [CryptoService, SecretsService],
})
export class CryptoModule {}
