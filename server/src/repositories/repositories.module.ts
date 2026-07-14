import { Module } from '@nestjs/common';
import { TargetsModule } from '../targets/targets.module';
import { RepositoriesController } from './repositories.controller';
import { RepositoriesService } from './repositories.service';

@Module({
  imports: [TargetsModule],
  controllers: [RepositoriesController],
  providers: [RepositoriesService],
  exports: [RepositoriesService],
})
export class RepositoriesModule {}
