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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { NotificationsService } from './notifications.service';
import { channelCatalog } from './channel-registry';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel.dto';

@ApiTags('notifications')
@RequireAdmin()
@Controller('notification-channels')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('providers')
  @ApiOperation({ summary: 'Notification provider catalog (field schemas)' })
  providers() {
    return channelCatalog();
  }

  @Get()
  @ApiOperation({ summary: 'List notification channels (admin)' })
  list() {
    return this.notifications.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a notification channel (admin)' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateChannelDto) {
    return this.notifications.create(user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a notification channel (admin)' })
  get(@Param('id') id: string) {
    return this.notifications.get(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a notification channel (admin)' })
  update(@Param('id') id: string, @Body() dto: UpdateChannelDto) {
    return this.notifications.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a notification channel (admin)' })
  async remove(@Param('id') id: string) {
    await this.notifications.remove(id);
    return { ok: true };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Send a test notification (admin)' })
  test(@Param('id') id: string) {
    return this.notifications.test(id);
  }
}
