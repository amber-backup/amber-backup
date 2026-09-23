import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { SlugResolverService } from '../common/slug-resolver.service';
import { RepositoriesService } from './repositories.service';

@ApiTags('repositories')
@Controller('repositories')
export class RepositoriesController {
  constructor(
    private readonly repositories: RepositoriesService,
    private readonly slugs: SlugResolverService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List repositories the user can view' })
  list(@CurrentUser() user: RequestUser) {
    return this.repositories.list(user);
  }

  @Get('stats-history')
  @ApiOperation({
    summary:
      'Storage readings over time for the repositories the user can view (dashboard growth chart)',
  })
  @ApiQuery({ name: 'days', required: false, description: 'Window in days (1–3650, default 30)' })
  statsHistory(@CurrentUser() user: RequestUser, @Query('days') days?: string) {
    const n = Math.min(3650, Math.max(1, Math.floor(Number(days)) || 30));
    return this.repositories.statsHistory(user, n);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a repository (by id or slug), including live size and snapshot count',
  })
  async get(@CurrentUser() user: RequestUser, @Param('id') idOrSlug: string) {
    const id = await this.slugs.resolve('repositories', idOrSlug);
    return this.repositories.findOne(user, id);
  }

  @Post(':id/stats')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Re-read size and snapshot count from restic and cache them on the repository; for a job on an agent, queue the read for that agent (queued: true)',
  })
  async refreshStats(
    @CurrentUser() user: RequestUser,
    @Param('id') idOrSlug: string,
  ) {
    const id = await this.slugs.resolve('repositories', idOrSlug);
    return this.repositories.refreshStatsFor(user, id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Resolve decrypted credentials to run restic locally against this repository (requires operate access; remote repositories only)',
  })
  async resolve(
    @CurrentUser() user: RequestUser,
    @Param('id') idOrSlug: string,
  ) {
    const id = await this.slugs.resolve('repositories', idOrSlug);
    return this.repositories.resolve(user, id);
  }
}
