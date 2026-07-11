import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Public,
  RequireAdmin,
} from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestUser } from '../common/auth/request-user';
import { AgentsService } from './agents.service';
import {
  CreateEnrollmentTokenDto,
  UpdateAgentDto,
} from './dto/agent.dto';

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Public()
  @Get('install.sh')
  @Header('content-type', 'text/x-shellscript')
  @ApiOperation({ summary: 'Agent install script (referenced by enroll cmd)' })
  installScript(): string {
    return this.agents.installScript();
  }

  @Public()
  @Get('binary/:target')
  @ApiOperation({ summary: 'Download the compiled agent binary (linux-amd64/arm64)' })
  binary(@Param('target') target: string): StreamableFile {
    return this.agents.binary(target);
  }

  @RequireAdmin()
  @Get()
  @ApiOperation({ summary: 'List agents (admin)' })
  list() {
    return this.agents.list();
  }

  @RequireAdmin()
  @Post('enrollment-tokens')
  @ApiOperation({ summary: 'Create an enrollment token + install command' })
  createToken(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateEnrollmentTokenDto,
  ) {
    return this.agents.createEnrollmentToken(user.id, dto);
  }

  @RequireAdmin()
  @Get(':id')
  @ApiOperation({ summary: 'Get an agent (admin)' })
  get(@Param('id') id: string) {
    return this.agents.get(id);
  }

  @RequireAdmin()
  @Patch(':id')
  @ApiOperation({ summary: 'Update an agent (admin)' })
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.update(id, dto);
  }

  @RequireAdmin()
  @Delete(':id')
  @ApiOperation({ summary: 'Remove an agent (admin)' })
  async remove(@Param('id') id: string) {
    await this.agents.remove(id);
    return { ok: true };
  }
}
