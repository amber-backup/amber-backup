import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UpdateCheckService } from './update-check.service';
import { UpdateStatusDto } from './dto/update-status.dto';

@ApiTags('updates')
@Controller('updates')
export class UpdatesController {
  constructor(private readonly updates: UpdateCheckService) {}

  @Get('latest')
  @ApiOperation({ summary: 'Newest published Amber Backup release' })
  @ApiOkResponse({ type: UpdateStatusDto })
  latest(): UpdateStatusDto {
    return this.updates.getStatus();
  }
}
