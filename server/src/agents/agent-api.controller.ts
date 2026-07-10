import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CurrentAgent } from '../common/decorators/current-user.decorator';
import { RequestAgent } from '../common/auth/request-user';
import { AgentAuthGuard } from '../common/guards/agent-auth.guard';
import { AgentsService } from './agents.service';
import {
  EnrollDto,
  PollDto,
  TaskProgressDto,
  TaskResultDto,
} from './dto/agent.dto';

/**
 * Agent-facing API. Bypasses the user AuthGuard (@Public) and authenticates
 * with the agent credential via AgentAuthGuard — except enroll, which is
 * gated by the one-time enrollment token in its body.
 */
@ApiTags('agent-api')
@Public()
@Controller('agents')
export class AgentApiController {
  constructor(private readonly agents: AgentsService) {}

  @Post('enroll')
  @ApiOperation({ summary: 'Enroll a new agent with a one-time token' })
  enroll(@Body() dto: EnrollDto) {
    return this.agents.enroll(dto);
  }

  @UseGuards(AgentAuthGuard)
  @Post('me/poll')
  @ApiOperation({ summary: 'Heartbeat + fetch queued tasks' })
  poll(@CurrentAgent() agent: RequestAgent, @Body() dto: PollDto) {
    return this.agents.poll(agent, dto);
  }

  @UseGuards(AgentAuthGuard)
  @Post('me/tasks/:id/progress')
  @ApiOperation({ summary: 'Report task progress' })
  progress(
    @CurrentAgent() agent: RequestAgent,
    @Param('id') id: string,
    @Body() dto: TaskProgressDto,
  ) {
    return this.agents.submitProgress(agent.id, id, dto.stats);
  }

  @UseGuards(AgentAuthGuard)
  @Post('me/tasks/:id/result')
  @ApiOperation({ summary: 'Report task result' })
  result(
    @CurrentAgent() agent: RequestAgent,
    @Param('id') id: string,
    @Body() dto: TaskResultDto,
  ) {
    return this.agents.submitResult(agent.id, id, dto);
  }
}
