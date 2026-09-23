import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { createPublicKey } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { chain, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
process.env.PUBLIC_BASE_URL = 'https://backup.example.com';

import { CryptoService } from '../crypto/crypto.service';
import { AgentsService } from './agents.service';
import { TargetsService } from '../targets/targets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { PruneRunnerService } from '../jobs/prune-runner.service';
import { CheckRunnerService } from '../jobs/check-runner.service';
import { RunRetryService } from '../jobs/run-retry.service';

describe('AgentsService (enrollment tokens & agent keys)', () => {
  let crypto: CryptoService;
  const targets = {} as TargetsService;
  const notifications = {} as NotificationsService;
  const repositories = {} as RepositoriesService;
  const pruneRunner = {} as PruneRunnerService;
  const checkRunner = {} as CheckRunnerService;
  const retries = { finalize: jest.fn(async () => undefined) } as unknown as RunRetryService;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
    process.env.PUBLIC_BASE_URL = 'https://backup.example.com';
    crypto = new CryptoService();
  });

  describe('createEnrollmentToken', () => {
    it('persists only the token hash and returns the plaintext token once', async () => {
      const insert = chain({ execute: [] });
      const { db } = createDbMock({ insertInto: insert });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      const result = await service.createEnrollmentToken('admin-1', {});

      const stored = insert.values.mock.calls[0][0] as { token_hash: string };
      expect(stored.token_hash).toBe(crypto.hashToken(result.token));
      expect(stored.token_hash).not.toBe(result.token);
      expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
      // The plaintext token is embedded in the install command shown to the admin.
      expect(result.installCommand).toContain(result.token);
    });

    it('emits a docker-compose file for the docker-compose method', async () => {
      const { db } = createDbMock({ insertInto: chain({ execute: [] }) });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      const result = await service.createEnrollmentToken('admin-1', {
        deployMethod: 'docker-compose',
      });

      expect(result.deployMethod).toBe('docker-compose');
      expect(result.installCommand).toContain('services:');
      expect(result.installCommand).toContain('amber-agent:');
      expect(result.installCommand).toContain(`AMBER_TOKEN: ${result.token}`);
      expect(result.installCommand).toContain('- amber-agent:/var/lib/amber-agent');
    });

    it('emits a docker run command for the docker method', async () => {
      const { db } = createDbMock({ insertInto: chain({ execute: [] }) });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      const result = await service.createEnrollmentToken('admin-1', {
        deployMethod: 'docker',
      });

      expect(result.installCommand).toMatch(/^docker run /);
      expect(result.installCommand).toContain(`AMBER_TOKEN=${result.token}`);
    });
  });

  describe('binary', () => {
    it('streams a bundled binary for a supported target', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'agent-bin-'));
      writeFileSync(path.join(dir, 'amber-agent-linux-amd64'), 'ELF');
      process.env.AGENT_BINARY_DIR = dir;
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      expect(service.binary('linux-amd64')).toBeInstanceOf(StreamableFile);
    });

    it('rejects an unsupported target (no path traversal)', () => {
      process.env.AGENT_BINARY_DIR = tmpdir();
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      expect(() => service.binary('linux-amd64/../../etc/passwd')).toThrow(
        NotFoundException,
      );
      expect(() => service.binary('windows-amd64')).toThrow(NotFoundException);
    });

    it('404s when the binary is not bundled on this server', () => {
      process.env.AGENT_BINARY_DIR = mkdtempSync(path.join(tmpdir(), 'empty-'));
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      expect(() => service.binary('linux-arm64')).toThrow(NotFoundException);
    });
  });

  describe('latestAgentVersion', () => {
    it('reads the bundled version file (drives agent self-update)', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'agent-ver-'));
      writeFileSync(path.join(dir, 'version'), '1.4.2\n');
      process.env.AGENT_BINARY_DIR = dir;
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      expect(service.latestAgentVersion()).toBe('1.4.2');
    });

    it('returns null when no version file is bundled (dev)', () => {
      process.env.AGENT_BINARY_DIR = mkdtempSync(path.join(tmpdir(), 'nover-'));
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      expect(service.latestAgentVersion()).toBeNull();
    });
  });

  describe('enroll', () => {
    function validTokenRow() {
      return {
        id: 'tok-1',
        used_at: null,
        expires_at: new Date(Date.now() + 60_000),
        intended_agent_name: null,
      };
    }

    // Route the app_settings lookup (global-token check) to "not configured" so
    // enroll falls through to the one-time enrollment_tokens path.
    const noGlobal =
      (tokenChain: ReturnType<typeof chain>) =>
      (table: string): ReturnType<typeof chain> =>
        table === 'app_settings' ? chain({ executeTakeFirst: undefined }) : tokenChain;

    it('rejects an unknown token', async () => {
      const select = chain({ executeTakeFirst: undefined });
      const { db } = createDbMock({ selectFrom: noGlobal(select) });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      await expect(
        service.enroll({ token: 'nope', agentName: 'web-1' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an already-used token', async () => {
      const select = chain({
        executeTakeFirst: { ...validTokenRow(), used_at: new Date() },
      });
      const { db } = createDbMock({ selectFrom: noGlobal(select) });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      await expect(
        service.enroll({ token: 't', agentName: 'web-1' } as never),
      ).rejects.toThrow(/already used/);
    });

    it('rejects an expired token', async () => {
      const select = chain({
        executeTakeFirst: {
          ...validTokenRow(),
          expires_at: new Date(Date.now() - 1000),
        },
      });
      const { db } = createDbMock({ selectFrom: noGlobal(select) });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      await expect(
        service.enroll({ token: 't', agentName: 'web-1' } as never),
      ).rejects.toThrow(/expired/);
    });

    it('generates an ed25519 server keypair and stores only the agent key hash', async () => {
      const select = chain({ executeTakeFirst: validTokenRow() });
      const insert = chain({
        executeTakeFirstOrThrow: { id: 'agent-1', poll_interval_seconds: 30 },
      });
      // The atomic one-time-token claim reports one row updated.
      const update = chain({ execute: [], executeTakeFirst: { numUpdatedRows: 1 } });
      const { db, updateTable } = createDbMock({
        selectFrom: noGlobal(select),
        insertInto: insert,
        updateTable: update,
      });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      const result = await service.enroll({
        token: 'plaintext-token',
        agentName: 'web-1',
      } as never);

      // Token is looked up by hash, never by plaintext.
      expect(select.where.mock.calls[0]).toEqual([
        'token_hash',
        '=',
        crypto.hashToken('plaintext-token'),
      ]);

      const stored = insert.values.mock.calls[0][0] as {
        agent_key_hash: string;
        server_privkey: string;
      };
      // The long-lived agent credential is returned once, only its hash stored.
      expect(stored.agent_key_hash).toBe(crypto.hashToken(result.agentKey));
      expect(stored.agent_key_hash).not.toBe(result.agentKey);

      // A valid ed25519 PEM keypair is generated; the private key is persisted,
      // the matching public key handed back to the agent.
      expect(stored.server_privkey).toContain('BEGIN PRIVATE KEY');
      expect(result.serverPubkey).toContain('BEGIN PUBLIC KEY');
      const derived = createPublicKey(stored.server_privkey)
        .export({ type: 'spki', format: 'pem' })
        .toString();
      expect(derived).toBe(result.serverPubkey);
      expect(createPublicKey(result.serverPubkey).asymmetricKeyType).toBe(
        'ed25519',
      );

      // The token is burned after a successful enrollment.
      expect(updateTable).toHaveBeenCalledWith('enrollment_tokens');
      expect(update.set.mock.calls[0][0]).toHaveProperty('used_at');
    });

    it('rejects a concurrent second enrollment that loses the atomic claim', async () => {
      const select = chain({ executeTakeFirst: validTokenRow() });
      const insert = chain({
        executeTakeFirstOrThrow: { id: 'agent-1', poll_interval_seconds: 30 },
      });
      // The conditional UPDATE ... WHERE used_at IS NULL matched no row: another
      // enrollment already consumed the token.
      const update = chain({ execute: [], executeTakeFirst: { numUpdatedRows: 0 } });
      const { db } = createDbMock({
        selectFrom: noGlobal(select),
        insertInto: insert,
        updateTable: update,
      });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      await expect(
        service.enroll({ token: 't', agentName: 'web-1' } as never),
      ).rejects.toThrow(/already used/);
      // The agent must not be created when the claim is lost.
      expect(insert.executeTakeFirstOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('global (self-registration) token', () => {
    // A stored app_settings row holding an encrypted global token.
    const storedGlobal = (token: string, enabled = true) => {
      const enc = crypto.encrypt(token);
      return chain({
        executeTakeFirst: {
          value: JSON.stringify({
            enabled,
            ciphertext: enc.ciphertext,
            nonce: enc.nonce,
          }),
        },
      });
    };

    it('mints and encrypts a token on first enable', async () => {
      const insert = chain({ execute: [] });
      const { db } = createDbMock({
        selectFrom: chain({ executeTakeFirst: undefined }), // nothing stored yet
        insertInto: insert,
      });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      const res = await service.setGlobalEnrollment(true);

      expect(res.enabled).toBe(true);
      expect(res.token).toBeTruthy();
      const stored = insert.values.mock.calls[0][0] as { value: string };
      const parsed = JSON.parse(stored.value);
      expect(parsed.enabled).toBe(true);
      expect(parsed.ciphertext).toBeTruthy();
      // The plaintext token is never stored.
      expect(stored.value).not.toContain(res.token as string);
    });

    it('hides the token when disabled', async () => {
      const { db } = createDbMock({
        selectFrom: storedGlobal('SECRET-GLOBAL', false),
      });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      await expect(service.getGlobalEnrollment()).resolves.toEqual({
        enabled: false,
        token: null,
      });
    });

    it('exposes rollout commands with a name placeholder when enabled', async () => {
      const { db } = createDbMock({
        selectFrom: storedGlobal('SECRET-GLOBAL'),
      });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      const info = await service.globalEnrollmentInfo();
      expect(info.enabled).toBe(true);
      expect(info.token).toBe('SECRET-GLOBAL');
      expect(info.commands!.binary).toContain('SECRET-GLOBAL');
      expect(info.commands!.binary).toContain(info.namePlaceholder);
      expect(info.commands!['docker-compose']).toContain(info.namePlaceholder);
    });

    it('enrolls via the global token without consuming it, using the agent-chosen name', async () => {
      const insert = chain({
        executeTakeFirstOrThrow: { id: 'agent-9', poll_interval_seconds: 30 },
      });
      const { db, updateTable } = createDbMock({
        selectFrom: (table) =>
          table === 'app_settings'
            ? storedGlobal('GLOBAL-TOK')
            : chain({ executeTakeFirst: undefined }),
        insertInto: insert,
      });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      const result = await service.enroll({
        token: 'GLOBAL-TOK',
        agentName: 'web-9',
      } as never);

      expect(result.agentId).toBe('agent-9');
      const stored = insert.values.mock.calls[0][0] as { name: string };
      expect(stored.name).toBe('web-9'); // agent names itself
      // Global token is reusable: no enrollment_tokens row is consumed.
      expect(updateTable).not.toHaveBeenCalled();
    });

    it('rejects global enrollment without an agent name', async () => {
      const { db } = createDbMock({
        selectFrom: (table) =>
          table === 'app_settings'
            ? storedGlobal('GLOBAL-TOK')
            : chain({ executeTakeFirst: undefined }),
      });
      const service = new AgentsService(db, crypto, targets, notifications, repositories, pruneRunner, checkRunner, retries);

      await expect(
        service.enroll({ token: 'GLOBAL-TOK', agentName: '  ' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
  describe('task results for a cancelled run', () => {
    /** The agent posts against a run the operator has meanwhile cancelled. */
    function makeService(updateTable: ReturnType<typeof chain>) {
      const { db } = createDbMock({
        selectFrom: chain({ executeTakeFirst: { id: 'run-1', job_id: 'j1', trigger: 'manual', repository_id: 'repo-1' } }),
        updateTable,
      });
      const repos = { refreshStatsInBackground: jest.fn() } as unknown as RepositoriesService;
      const notify = {
        notifyJobRun: jest.fn(async () => undefined),
      } as unknown as NotificationsService;
      return new AgentsService(db, crypto, targets, notify, repos, pruneRunner, checkRunner, retries);
    }

    it('only writes a backup result while the run is still running', async () => {
      const update = chain({ execute: [] });
      const service = makeService(update);

      await service.submitBackupResult('agent-1', 'run-1', {
        status: 'success',
        snapshotId: 'snap-1',
      } as never);

      // Without this guard a cancelled run would flip back to success.
      expect(update.where).toHaveBeenCalledWith('status', '=', 'running');
    });

    it('settles a backup result through the retry service', async () => {
      const service = makeService(chain({ execute: [] }));
      (retries.finalize as jest.Mock).mockClear();

      await service.submitBackupResult('agent-1', 'run-1', {
        status: 'failed',
        error: 'network unreachable',
      } as never);

      // A failure may be retried instead of notified; the retry service decides.
      expect(retries.finalize).toHaveBeenCalledWith('run-1');
    });

    it('only writes backup progress while the run is still running', async () => {
      const update = chain({ execute: [] });
      const service = makeService(update);

      await service.backupProgress('agent-1', 'run-1', { percentDone: 0.5 });

      expect(update.where).toHaveBeenCalledWith('status', '=', 'running');
    });

    it('only writes a restore result while the run is still running', async () => {
      const update = chain({ execute: [] });
      const service = makeService(update);

      await service.submitRestoreResult('agent-1', 'run-1', {
        status: 'success',
      } as never);

      expect(update.where).toHaveBeenCalledWith('status', '=', 'running');
    });

    it('only writes restore progress while the run is still running', async () => {
      const update = chain({ execute: [] });
      const service = makeService(update);

      await service.restoreProgress('agent-1', 'run-1', { percentDone: 0.5 });

      expect(update.where).toHaveBeenCalledWith('status', '=', 'running');
    });
  });

  describe('integrity checks', () => {
    const agent = { id: 'agent-1' } as never;

    function makePollService() {
      const select = chain({ execute: [] });
      const { db } = createDbMock({
        selectFrom: select,
        updateTable: chain({ executeTakeFirst: { poll_interval_seconds: 30 } }),
      });
      const repos = {
        claimStatsRequests: jest.fn().mockResolvedValue([]),
      } as unknown as RepositoriesService;
      const service = new AgentsService(db, crypto, targets, notifications, repos, pruneRunner, checkRunner, retries);
      return { service, select };
    }

    it('hands check tasks only to agents that announce the capability', async () => {
      const old = makePollService();
      await old.service.poll(agent, {});
      expect(old.select.where).not.toHaveBeenCalledWith('job_runs.kind', '=', 'check');

      const current = makePollService();
      await current.service.poll(agent, { capabilities: ['check'] });
      expect(current.select.where).toHaveBeenCalledWith('job_runs.kind', '=', 'check');
    });

    it('holds back backup retries until their delay has passed', async () => {
      const { service, select } = makePollService();
      await service.poll(agent, {});

      const filter = select.where.mock.calls.find((c) => typeof c[0] === 'function')?.[0] as
        | ((eb: unknown) => unknown)
        | undefined;
      expect(filter).toBeDefined();
      const eb = Object.assign(jest.fn((...args: unknown[]) => args), {
        or: jest.fn((parts: unknown[]) => parts),
      });
      const parts = filter!(eb) as unknown[][];
      expect(parts[0]).toEqual(['job_runs.not_before', 'is', null]);
      expect(parts[1].slice(0, 2)).toEqual(['job_runs.not_before', '<=']);
      expect(parts[1][2]).toBeInstanceOf(Date);
    });

    it('routes a check result to the check runner', async () => {
      const { db } = createDbMock({
        selectFrom: chain({ executeTakeFirst: { id: 'run-1', kind: 'check' } }),
        updateTable: chain({ execute: [] }),
      });
      const runner = { recordAgentResult: jest.fn().mockResolvedValue(undefined) };
      const service = new AgentsService(
        db,
        crypto,
        targets,
        notifications,
        repositories,
        pruneRunner,
        runner as unknown as CheckRunnerService,
        retries,
      );

      await service.submitResult('agent-1', 'run-1', {
        status: 'failed',
        damaged: true,
        error: 'damaged',
        log: 'Fatal: repository contains errors',
      } as never);

      expect(runner.recordAgentResult).toHaveBeenCalledWith('agent-1', 'run-1', {
        status: 'failed',
        damaged: true,
        error: 'damaged',
        log: 'Fatal: repository contains errors',
      });
    });
  });

  describe('repository stats', () => {
    const agent = { id: 'agent-1' } as never;
    const request = {
      id: 'repo-1',
      target_id: 't1',
      repo_config: {},
      repo_password_secret_id: 'sec',
      credential_secret_id: null,
    };

    function makePollService() {
      const { db } = createDbMock({
        selectFrom: chain({ execute: [] }),
        updateTable: chain({ executeTakeFirst: { poll_interval_seconds: 30 } }),
      });
      const repos = {
        claimStatsRequests: jest.fn().mockResolvedValue([request]),
        refreshStatsInBackground: jest.fn(),
      };
      const resolver = {
        resolveForJob: jest.fn().mockResolvedValue({
          repository: 's3:bucket/repo',
          password: 'pw',
          env: {},
          credentialFiles: [],
        }),
      };
      const service = new AgentsService(
        db,
        crypto,
        resolver as unknown as TargetsService,
        notifications,
        repos as unknown as RepositoriesService,
        pruneRunner,
        checkRunner,
        retries,
      );
      return { service, repos };
    }

    it('hands a requested refresh to an agent that announces the capability', async () => {
      const { service, repos } = makePollService();

      const { tasks } = await service.poll(agent, { capabilities: ['check', 'stats'] });

      expect(tasks).toEqual([
        expect.objectContaining({ type: 'stats', taskId: 'stats-repo-1', repository: 's3:bucket/repo' }),
      ]);
      expect(repos.refreshStatsInBackground).not.toHaveBeenCalled();
    });

    it('reads the repository on the server for an agent without the capability', async () => {
      const { service, repos } = makePollService();

      const { tasks } = await service.poll(agent, { capabilities: ['check'] });

      expect(tasks).toEqual([]);
      expect(repos.refreshStatsInBackground).toHaveBeenCalledWith('repo-1');
    });

    function makeResultService(owned: unknown) {
      const { db } = createDbMock({
        selectFrom: chain({
          executeTakeFirst: owned,
        }),
        updateTable: chain({ execute: [] }),
      });
      const repos = {
        recordStats: jest.fn().mockResolvedValue(undefined),
        refreshStatsInBackground: jest.fn(),
      };
      const prune = { record: jest.fn().mockResolvedValue('prune-1') };
      const service = new AgentsService(
        db,
        crypto,
        targets,
        notifications,
        repos as unknown as RepositoriesService,
        prune as unknown as PruneRunnerService,
        checkRunner,
        retries,
      );
      return { service, repos, prune };
    }

    it('records the figures of a stats task', async () => {
      const { service, repos } = makeResultService({ id: 'job-1' });

      await service.submitResult('agent-1', 'stats-repo-1', {
        status: 'success',
        repoStats: { sizeBytes: 4096, snapshotCount: 7 },
      } as never);

      expect(repos.recordStats).toHaveBeenCalledWith('repo-1', {
        size_bytes: 4096,
        snapshot_count: 7,
      });
    });

    it('rejects stats for a repository whose job runs elsewhere', async () => {
      const { service, repos } = makeResultService(undefined);

      await expect(
        service.submitResult('agent-1', 'stats-repo-1', {
          status: 'success',
          repoStats: { sizeBytes: 1, snapshotCount: 1 },
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(repos.recordStats).not.toHaveBeenCalled();
    });

    it('takes the figures a backup reported instead of reading them on the server', async () => {
      const { service, repos, prune } = makeResultService({
        id: 'run-1',
        job_id: 'j1',
        trigger: 'manual',
        repository_id: 'repo-1',
      });

      await service.submitBackupResult('agent-1', 'run-1', {
        status: 'success',
        repoStats: { sizeBytes: 4096, snapshotCount: 7 },
        prune: {
          status: 'success',
          startedAt: '2026-09-23T10:00:00Z',
          finishedAt: '2026-09-23T10:01:00Z',
        },
      } as never);

      expect(repos.recordStats).toHaveBeenCalledWith('repo-1', {
        size_bytes: 4096,
        snapshot_count: 7,
      });
      expect(repos.refreshStatsInBackground).not.toHaveBeenCalled();
      expect(prune.record).toHaveBeenCalledWith(expect.objectContaining({ statsReported: true }));
    });

    it('reads the repository on the server when an older agent reports no figures', async () => {
      const { service, repos } = makeResultService({
        id: 'run-1',
        job_id: 'j1',
        trigger: 'manual',
        repository_id: 'repo-1',
      });

      await service.submitBackupResult('agent-1', 'run-1', { status: 'success' } as never);

      expect(repos.recordStats).not.toHaveBeenCalled();
      expect(repos.refreshStatsInBackground).toHaveBeenCalledWith('repo-1');
    });
  });
});
