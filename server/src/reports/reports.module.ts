import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportSchedulerService } from './report-scheduler.service';

@Module({
  imports: [NotificationsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportSchedulerService],
  exports: [ReportsService, ReportSchedulerService],
})
export class ReportsModule {}
