import { Controller, Get, Header } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CliService } from './cli.service';

@ApiTags('cli')
@Controller('cli')
export class CliController {
  constructor(private readonly cli: CliService) {}

  @Public()
  @Get('install.sh')
  @Header('content-type', 'text/plain; charset=utf-8')
  @Header('cache-control', 'no-store')
  @ApiOperation({ summary: 'ambb CLI install script for Linux/macOS (curl … | sh)' })
  @ApiProduces('text/plain')
  @ApiOkResponse({ description: 'POSIX sh install script', schema: { type: 'string' } })
  @ApiNotFoundResponse({ description: 'Script not bundled with this server' })
  installSh(): string {
    return this.cli.installScript('sh');
  }

  @Public()
  @Get('install.ps1')
  @Header('content-type', 'text/plain; charset=utf-8')
  @Header('cache-control', 'no-store')
  @ApiOperation({ summary: 'ambb CLI install script for Windows (irm … | iex)' })
  @ApiProduces('text/plain')
  @ApiOkResponse({ description: 'PowerShell install script', schema: { type: 'string' } })
  @ApiNotFoundResponse({ description: 'Script not bundled with this server' })
  installPs1(): string {
    return this.cli.installScript('ps1');
  }
}
