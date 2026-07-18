import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { Public } from '../common/decorators/public.decorator';
import { SlugResolverService } from '../common/slug-resolver.service';
import { TargetsService } from './targets.service';
import { TargetHealthService } from './target-health.service';
import { backendCatalog } from './backend-registry';
import { CreateTargetDto, UpdateTargetDto } from './dto/target.dto';

@ApiTags('targets')
@Controller('targets')
export class TargetsController {
  constructor(
    private readonly targets: TargetsService,
    private readonly health: TargetHealthService,
    private readonly slugs: SlugResolverService,
  ) {}

  @Public()
  @Get('backends')
  @ApiOperation({ summary: 'Backend catalog (field schemas for the UI)' })
  backends() {
    return backendCatalog();
  }

  @Get()
  @ApiOperation({ summary: 'List connections the user can view' })
  list(@CurrentUser() user: RequestUser) {
    return this.targets.list(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a connection (shared backend access)' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateTargetDto) {
    const target = await this.targets.create(user, dto);
    // Probe in the background so the list shows a status right away.
    void this.health.refresh(target.id).catch(() => undefined);
    return target;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a target (by id or slug)' })
  async get(@CurrentUser() user: RequestUser, @Param('id') idOrSlug: string) {
    const id = await this.slugs.resolve('targets', idOrSlug);
    return this.targets.get(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a target (by id or slug)' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') idOrSlug: string,
    @Body() dto: UpdateTargetDto,
  ) {
    const id = await this.slugs.resolve('targets', idOrSlug);
    const target = await this.targets.update(user, id, dto);
    // An edit may have changed the endpoint — re-probe in the background.
    void this.health.refresh(id).catch(() => undefined);
    return target;
  }

  @Post(':id/check')
  @ApiOperation({ summary: 'Probe a connection now and return its status' })
  async check(@CurrentUser() user: RequestUser, @Param('id') idOrSlug: string) {
    const id = await this.slugs.resolve('targets', idOrSlug);
    await this.targets.get(user, id); // view access check
    return this.health.refresh(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a connection (by id or slug)' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') idOrSlug: string) {
    await this.targets.remove(
      user,
      await this.slugs.resolve('targets', idOrSlug),
    );
    return { ok: true };
  }
}
