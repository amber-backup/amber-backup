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
import { RequireAdmin } from '../common/decorators/public.decorator';
import { UsersService } from './users.service';
import { CreateGrantDto, CreateUserDto, UpdateUserDto } from './dto/auth.dto';

@ApiTags('users')
@RequireAdmin()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List all users (admin)' })
  list() {
    return this.users.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a local user (admin)' })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto, 'local');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user (admin)' })
  get(@Param('id') id: string) {
    return this.users.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user (admin)' })
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Post(':id/enable')
  @ApiOperation({ summary: 'Enable a user (e.g. approve SSO user)' })
  enable(@Param('id') id: string) {
    return this.users.enable(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a user (admin)' })
  async remove(@Param('id') id: string) {
    await this.users.remove(id);
    return { ok: true };
  }

  @Get(':id/grants')
  @ApiOperation({ summary: 'List a user\'s resource grants' })
  listGrants(@Param('id') id: string) {
    return this.users.listGrants(id);
  }

  @Post(':id/grants')
  @ApiOperation({ summary: 'Add/update a resource grant' })
  addGrant(@Param('id') id: string, @Body() dto: CreateGrantDto) {
    return this.users.addGrant(id, dto);
  }

  @Delete(':id/grants/:grantId')
  @ApiOperation({ summary: 'Remove a resource grant' })
  async removeGrant(
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ) {
    await this.users.removeGrant(id, grantId);
    return { ok: true };
  }
}
