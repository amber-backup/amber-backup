import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a repository (by id or slug), including live size and snapshot count',
  })
  async get(@CurrentUser() user: RequestUser, @Param('id') idOrSlug: string) {
    const id = await this.slugs.resolve('repositories', idOrSlug);
    return this.repositories.findOne(user, id);
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
