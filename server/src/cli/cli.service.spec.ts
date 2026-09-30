import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { CliService } from './cli.service';

const REPO_CLI_DIR = path.resolve(__dirname, '..', '..', '..', 'cli');

describe('CliService (install scripts)', () => {
  const env = { ...process.env };
  let service: CliService;

  function versionDir(version: string | null): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-ver-'));
    if (version !== null) writeFileSync(path.join(dir, 'version'), `${version}\n`);
    return dir;
  }

  beforeEach(() => {
    delete process.env.CLI_SCRIPT_DIR;
    process.env.AGENT_BINARY_DIR = versionDir('1.36.0');
    process.env.PUBLIC_BASE_URL = 'https://backup.example.com/';
    service = new CliService();
  });

  afterAll(() => {
    process.env = env;
  });

  it('defaults to the scripts in the repo cli/ directory', () => {
    const sh = service.installScript('sh');
    expect(sh.startsWith('#!/bin/sh')).toBe(true);
    const ps1 = service.installScript('ps1');
    expect(ps1).toContain('Expand-Archive');
  });

  it('fills in the server version and URL (trailing slash stripped)', () => {
    const sh = service.installScript('sh');
    expect(sh).toContain('AMBB_VERSION="${AMBB_VERSION:-1.36.0}"');
    expect(sh).toContain('AMBER_URL="${AMBER_URL:-https://backup.example.com}"');
    expect(sh).not.toContain('AMBB_VERSION="${AMBB_VERSION:-latest}"');

    const ps1 = service.installScript('ps1');
    expect(ps1).toContain(
      "    $Version = if ($env:AMBB_VERSION) { $env:AMBB_VERSION } else { '1.36.0' }",
    );
    expect(ps1).toContain(
      "    $AmberUrl = if ($env:AMBER_URL) { $env:AMBER_URL } else { 'https://backup.example.com' }",
    );
  });

  it('changes nothing but the two default lines', () => {
    const original = readFileSync(path.join(REPO_CLI_DIR, 'install.sh'), 'utf8').split('\n');
    const served = service.installScript('sh').split('\n');
    expect(served).toHaveLength(original.length);
    const changed = served.filter((l, i) => l !== original[i]);
    expect(changed).toEqual([
      'AMBB_VERSION="${AMBB_VERSION:-1.36.0}"',
      'AMBER_URL="${AMBER_URL:-https://backup.example.com}"',
    ]);
  });

  it('keeps "latest" when the server version is unknown (dev)', () => {
    process.env.AGENT_BINARY_DIR = versionDir(null);
    expect(service.installScript('sh')).toContain('AMBB_VERSION="${AMBB_VERSION:-latest}"');
    expect(service.installScript('ps1')).toContain("else { 'latest' }");
  });

  it('keeps a URL with a sub-path and port', () => {
    process.env.PUBLIC_BASE_URL = 'http://10.0.0.5:8080/amber';
    expect(service.installScript('sh')).toContain(
      'AMBER_URL="${AMBER_URL:-http://10.0.0.5:8080/amber}"',
    );
  });

  it.each([
    '1.2.3"; rm -rf /; echo "',
    "1.2.3'; Remove-Item C:\\ -Recurse; '",
    '1.2.3$(id)',
    '1.2',
    'latest',
  ])('never injects a malformed version: %s', (version) => {
    process.env.AGENT_BINARY_DIR = versionDir(version);
    expect(service.installScript('sh')).toContain('AMBB_VERSION="${AMBB_VERSION:-latest}"');
    expect(service.installScript('ps1')).toContain("else { 'latest' }");
  });

  it.each([
    'https://backup.example.com/$(id)',
    'https://backup.example.com/`id`',
    'https://backup.example.com/"; id; "',
    "https://backup.example.com/'; Remove-Item C:\\; '",
    'https://backup.example.com/${IFS}',
    'https://user:pass@backup.example.com',
    'ftp://backup.example.com',
    'https://backup.example.com/a b',
  ])('never injects a malformed URL: %s', (url) => {
    process.env.PUBLIC_BASE_URL = url;
    expect(service.installScript('sh')).toContain('AMBER_URL="${AMBER_URL:-}"');
    expect(service.installScript('ps1')).toContain(
      "$AmberUrl = if ($env:AMBER_URL) { $env:AMBER_URL } else { '' }",
    );
  });

  it('404s when the script is not bundled on this server', () => {
    process.env.CLI_SCRIPT_DIR = mkdtempSync(path.join(tmpdir(), 'cli-empty-'));
    expect(() => service.installScript('sh')).toThrow(NotFoundException);
    expect(() => service.installScript('ps1')).toThrow(NotFoundException);
  });

  it('fails loudly when a default marker line is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cli-bad-'));
    const script = readFileSync(path.join(REPO_CLI_DIR, 'install.sh'), 'utf8');
    writeFileSync(
      path.join(dir, 'install.sh'),
      script.replace('AMBER_URL="${AMBER_URL:-}"', 'AMBER_URL="${AMBER_URL:-x}"'),
    );
    copyFileSync(path.join(REPO_CLI_DIR, 'install.ps1'), path.join(dir, 'install.ps1'));
    process.env.CLI_SCRIPT_DIR = dir;
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

    expect(() => service.installScript('sh')).toThrow(InternalServerErrorException);
    expect(service.installScript('ps1')).toContain("else { '1.36.0' }");
  });

  it('serves a script that still parses as POSIX sh', () => {
    const result = spawnSync('sh', ['-n'], { input: service.installScript('sh') });
    expect(result.status).toBe(0);
  });
});
