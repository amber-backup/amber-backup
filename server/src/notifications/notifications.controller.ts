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
import { SlugResolverService } from '../common/slug-resolver.service';
import { NotificationsService } from './notifications.service';
import { channelCatalog } from './channel-registry';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel.dto';

@ApiTags('notifications')
@RequireAdmin()
@Controller('notification-channels')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly slugs: SlugResolverService,
  ) {}

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
  @ApiOperation({ summary: 'Get a notification channel by id or slug (admin)' })
  async get(@Param('id') idOrSlug: string) {
    return this.notifications.get(await this.resolve(idOrSlug));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a notification channel by id or slug (admin)',
  })
  async update(@Param('id') idOrSlug: string, @Body() dto: UpdateChannelDto) {
    return this.notifications.update(await this.resolve(idOrSlug), dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a notification channel by id or slug (admin)',
  })
  async remove(@Param('id') idOrSlug: string) {
    await this.notifications.remove(await this.resolve(idOrSlug));
    return { ok: true };
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Send a test notification (admin)' })
  async test(@Param('id') idOrSlug: string) {
    return this.notifications.test(await this.resolve(idOrSlug));
  }

  private resolve(idOrSlug: string): Promise<string> {
    return this.slugs.resolve('notification_channels', idOrSlug);
  }
}
