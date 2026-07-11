import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { RunsService } from './runs.service';

@ApiTags('runs')
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  @ApiOperation({ summary: 'List backup runs (history + live)' })
  list(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('jobId') jobId?: string,
    @Query('status') status?: string,
  ) {
    return this.runs.list(user, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      jobId,
      status,
    });
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Dashboard aggregates' })
  dashboard(@CurrentUser() user: RequestUser) {
    return this.runs.dashboard(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single run (with log + stats)' })
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.runs.get(user, id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a running or queued run' })
  cancel(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.runs.cancel(user, id);
  }
}
