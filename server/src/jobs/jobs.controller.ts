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
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { JobsService } from './jobs.service';
import { SchedulerService } from './scheduler.service';
import { JobRunnerService } from './job-runner.service';
import { CreateJobDto, UpdateJobDto, TestRepoDto } from './dto/job.dto';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly scheduler: SchedulerService,
    private readonly runner: JobRunnerService,
    private readonly targets: TargetsService,
    private readonly restic: ResticService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List jobs the user can view' })
  async list(@CurrentUser() user: RequestUser) {
    const jobs = await this.jobs.list(user);
    return jobs.map((j) => ({
      ...j,
      next_run: this.jobs.nextRun(j.cron_expr),
    }));
  }

  @Post('test-repo')
  @ApiOperation({ summary: 'Test a repository (saved or pre-save connection)' })
  async testRepo(@CurrentUser() user: RequestUser, @Body() dto: TestRepoDto) {
    if (dto.targetId) await this.targets.get(user, dto.targetId); // view check
    const ctx = await this.targets.resolveRepoAdHoc({
      targetId: dto.targetId,
      backendType: dto.backendType,
      targetConfig: dto.targetConfig,
      repoConfig: dto.repoConfig,
      repoPassword: dto.repoPassword,
    });
    return this.restic.testConnection(ctx);
  }

  @Post()
  @ApiOperation({ summary: 'Create a backup job' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateJobDto) {
    const job = await this.jobs.create(user, dto);
    await this.scheduler.sync(job.id);
    return job;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a job' })
  async get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const job = await this.jobs.get(user, id);
    return { ...job, next_run: this.jobs.nextRun(job.cron_expr) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a job' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateJobDto,
  ) {
    const job = await this.jobs.update(user, id, dto);
    await this.scheduler.sync(job.id);
    return job;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a job' })
  async remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.jobs.remove(user, id);
    this.scheduler.unregister(id);
    return { ok: true };
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'Trigger a job manually' })
  async run(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.jobs.assertOperate(user, id);
    const runId = await this.jobs.createRun(id, 'manual');
    await this.runner.dispatch(runId);
    return { runId };
  }
}
