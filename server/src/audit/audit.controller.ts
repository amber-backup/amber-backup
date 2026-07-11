import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireAdmin } from '../common/decorators/public.decorator';
import { AuditOutcome } from '../database/database.types';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
@RequireAdmin()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated audit log (admin)' })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('resourceType') resourceType?: string,
    @Query('outcome') outcome?: string,
  ) {
    return this.audit.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search: search || undefined,
      action: action || undefined,
      actorId: actorId || undefined,
      resourceType: resourceType || undefined,
      outcome: (outcome as AuditOutcome) || undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Single audit entry (admin)' })
  get(@Param('id') id: string) {
    return this.audit.get(id);
  }
}
