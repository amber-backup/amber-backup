import { Controller, Delete, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { SnapshotsService } from './snapshots.service';

@ApiTags('snapshots')
@Controller('jobs/:id/snapshots')
export class SnapshotsController {
  constructor(private readonly snapshots: SnapshotsService) {}

  @Get()
  @ApiOperation({ summary: "List snapshots for a job's repository (filterable)" })
  list(
    @CurrentUser() user: RequestUser,
    @Param('id') jobId: string,
    @Query('host') host?: string,
    @Query('tags') tags?: string,
    @Query('path') path?: string,
  ) {
    return this.snapshots.list(user, jobId, {
      host,
      tags: tags ? tags.split(',') : undefined,
      path,
    });
  }

  @Get(':snap/ls')
  @ApiOperation({ summary: 'Browse the contents of a snapshot' })
  ls(
    @CurrentUser() user: RequestUser,
    @Param('id') jobId: string,
    @Param('snap') snapshotId: string,
    @Query('path') path?: string,
  ) {
    return this.snapshots.ls(user, jobId, snapshotId, path);
  }

  @Delete(':snap')
  @ApiOperation({ summary: 'Delete (forget) a snapshot; optionally prune' })
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id') jobId: string,
    @Param('snap') snapshotId: string,
    @Query('prune') prune?: string,
  ) {
    return this.snapshots.remove(user, jobId, snapshotId, prune === 'true');
  }
}
