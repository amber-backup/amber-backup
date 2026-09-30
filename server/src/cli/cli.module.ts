import { Module } from '@nestjs/common';
import { CliController } from './cli.controller';
import { CliService } from './cli.service';

/** Public install scripts for the ambb CLI (binaries come from GitHub). */
@Module({
  controllers: [CliController],
  providers: [CliService],
})
export class CliModule {}
