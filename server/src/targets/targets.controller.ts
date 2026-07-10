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
import { ResticService } from '../restic/restic.service';
import { TargetsService } from './targets.service';
import { backendCatalog } from './backend-registry';
import { CreateTargetDto, UpdateTargetDto } from './dto/target.dto';

@ApiTags('targets')
@Controller('targets')
export class TargetsController {
  constructor(
    private readonly targets: TargetsService,
    private readonly restic: ResticService,
  ) {}

  @Public()
  @Get('backends')
  @ApiOperation({ summary: 'Backend catalog (field schemas for the UI)' })
  backends() {
    return backendCatalog();
  }

  @Get()
  @ApiOperation({ summary: 'List targets the user can view' })
  list(@CurrentUser() user: RequestUser) {
    return this.targets.list(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a target (repository)' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateTargetDto) {
    return this.targets.create(user, dto);
  }

  @Post('test')
  @ApiOperation({ summary: 'Test an unsaved target configuration' })
  async testAdHoc(@Body() dto: CreateTargetDto) {
    const ctx = this.targets.resolveAdHoc(dto);
    return this.restic.testConnection(ctx);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a target' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.targets.get(user, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a target' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateTargetDto,
  ) {
    return this.targets.update(user, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a target' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.targets.remove(user, id);
    return { ok: true };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test connectivity of a saved target' })
  async test(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.targets.get(user, id); // view check
    const ctx = await this.targets.resolve(id);
    return this.restic.testConnection(ctx);
  }
}
