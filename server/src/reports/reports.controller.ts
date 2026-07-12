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
import { ReportsService } from './reports.service';
import { ReportSchedulerService } from './report-scheduler.service';
import { CreateReportDto, UpdateReportDto } from './dto/report.dto';

@ApiTags('reports')
@RequireAdmin()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly scheduler: ReportSchedulerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List report definitions (admin)' })
  async list() {
    const reports = await this.reports.list();
    return reports.map((r) => ({
      ...r,
      next_run: this.reports.nextRun(r.cron_expr),
    }));
  }

  @Post()
  @ApiOperation({ summary: 'Create a report definition (admin)' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateReportDto) {
    const report = await this.reports.create(user, dto);
    await this.scheduler.sync(report.id);
    return report;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a report definition (admin)' })
  async get(@Param('id') id: string) {
    const report = await this.reports.get(id);
    return { ...report, next_run: this.reports.nextRun(report.cron_expr) };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a report definition (admin)' })
  async update(@Param('id') id: string, @Body() dto: UpdateReportDto) {
    const report = await this.reports.update(id, dto);
    await this.scheduler.sync(report.id);
    return report;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a report definition (admin)' })
  async remove(@Param('id') id: string) {
    await this.reports.remove(id);
    this.scheduler.unregister(id);
    return { ok: true };
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'Generate and send a report now (admin)' })
  async run(@Param('id') id: string) {
    await this.reports.generate(id);
    return { ok: true };
  }
}
