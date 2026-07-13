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
import { backendCatalog } from './backend-registry';
import { CreateTargetDto, UpdateTargetDto } from './dto/target.dto';

@ApiTags('targets')
@Controller('targets')
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

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
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateTargetDto) {
    return this.targets.create(user, dto);
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
  @ApiOperation({ summary: 'Delete a connection' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.targets.remove(user, id);
    return { ok: true };
  }
}
