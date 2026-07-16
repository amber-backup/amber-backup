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
  @ApiOperation({ summary: 'Get a target' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.targets.get(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a target' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateTargetDto,
  ) {
    const target = await this.targets.update(user, id, dto);
    // An edit may have changed the endpoint — re-probe in the background.
    void this.health.refresh(id).catch(() => undefined);
    return target;
  }

  @Post(':id/check')
  @ApiOperation({ summary: 'Probe a connection now and return its status' })
  async check(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.targets.get(user, id); // view access check
    return this.health.refresh(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a connection' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.targets.remove(user, id);
    return { ok: true };
  }
}
