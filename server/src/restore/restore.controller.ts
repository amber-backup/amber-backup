import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { RestoreService } from './restore.service';
import { CreateRestoreDto } from './dto/restore.dto';

@ApiTags('restores')
@Controller('restores')
export class RestoreController {
  constructor(private readonly restore: RestoreService) {}

  @Post()
  @ApiOperation({ summary: 'Start a restore (dry-run or real)' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateRestoreDto) {
    return this.restore.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List restore runs' })
  list(@CurrentUser() user: RequestUser, @Query('limit') limit?: string) {
    return this.restore.list(user, limit ? Number(limit) : undefined);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a restore run' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.restore.get(user, id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a restore run' })
  cancel(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.restore.cancel(user, id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download the restore archive (download mode)' })
  async download(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { path, filename } = await this.restore.getDownload(user, id);
    res.download(path, filename);
  }
}
