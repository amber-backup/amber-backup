import { Controller, Delete, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { SnapshotsService } from './snapshots.service';

@ApiTags('snapshots')
@Controller('targets/:id/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  @Get()
  @ApiOperation({ summary: 'List snapshots for a target (filterable)' })
  list(
    @CurrentUser() user: RequestUser,
    @Param('id') targetId: string,
    @Query('host') host?: string,
    @Query('tags') tags?: string,
    @Query('path') path?: string,
  ) {
    return this.snapshots.list(user, targetId, {
      host,
      tags: tags ? tags.split(',') : undefined,
      path,
    });
  }

  @Get(':snap/ls')
  @ApiOperation({ summary: 'Browse the contents of a snapshot' })
  ls(
    @CurrentUser() user: RequestUser,
    @Param('id') targetId: string,
    @Param('snap') snapshotId: string,
    @Query('path') path?: string,
  ) {
    return this.snapshots.ls(user, targetId, snapshotId, path);
  }

  @Delete(':snap')
  @ApiOperation({ summary: 'Delete (forget) a snapshot; optionally prune' })
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id') targetId: string,
    @Param('snap') snapshotId: string,
    @Query('prune') prune?: string,
  ) {
    return this.snapshots.remove(user, targetId, snapshotId, prune === 'true');
  }
}
