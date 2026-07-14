import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { RepositoriesService } from './repositories.service';

@ApiTags('repositories')
@Controller('repositories')
export class RepositoriesController {
  constructor(private readonly repositories: RepositoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List repositories the user can view' })
  list(@CurrentUser() user: RequestUser) {
    return this.repositories.list(user);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a repository, including live size and snapshot count',
  })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.repositories.findOne(user, id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Resolve decrypted credentials to run restic locally against this repository (requires operate access; remote repositories only)',
  })
  resolve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.repositories.resolve(user, id);
  }
}
