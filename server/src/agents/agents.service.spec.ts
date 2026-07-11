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

describe('AgentsService (enrollment tokens & agent keys)', () => {
  let crypto: CryptoService;
  const targets = {} as TargetsService;
  const notifications = {} as NotificationsService;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
    process.env.PUBLIC_BASE_URL = 'https://backup.example.com';
    crypto = new CryptoService();
  });

  describe('createEnrollmentToken', () => {
    it('persists only the token hash and returns the plaintext token once', async () => {
      const insert = chain({ execute: [] });
      const { db } = createDbMock({ insertInto: insert });
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

      expect(service.binary('linux-amd64')).toBeInstanceOf(StreamableFile);
    });

    it('rejects an unsupported target (no path traversal)', () => {
      process.env.AGENT_BINARY_DIR = tmpdir();
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications);

      expect(() => service.binary('linux-amd64/../../etc/passwd')).toThrow(
        NotFoundException,
      );
      expect(() => service.binary('windows-amd64')).toThrow(NotFoundException);
    });

    it('404s when the binary is not bundled on this server', () => {
      process.env.AGENT_BINARY_DIR = mkdtempSync(path.join(tmpdir(), 'empty-'));
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications);

      expect(() => service.binary('linux-arm64')).toThrow(NotFoundException);
    });
  });

  describe('latestAgentVersion', () => {
    it('reads the bundled version file (drives agent self-update)', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'agent-ver-'));
      writeFileSync(path.join(dir, 'version'), '1.4.2\n');
      process.env.AGENT_BINARY_DIR = dir;
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications);

      expect(service.latestAgentVersion()).toBe('1.4.2');
    });

    it('returns null when no version file is bundled (dev)', () => {
      process.env.AGENT_BINARY_DIR = mkdtempSync(path.join(tmpdir(), 'nover-'));
      const { db } = createDbMock({});
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

      await expect(
        service.enroll({ token: 'nope', agentName: 'web-1' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an already-used token', async () => {
      const select = chain({
        executeTakeFirst: { ...validTokenRow(), used_at: new Date() },
      });
      const { db } = createDbMock({ selectFrom: noGlobal(select) });
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

      await expect(
        service.enroll({ token: 't', agentName: 'web-1' } as never),
      ).rejects.toThrow(/expired/);
    });

    it('generates an ed25519 server keypair and stores only the agent key hash', async () => {
      const select = chain({ executeTakeFirst: validTokenRow() });
      const insert = chain({
        executeTakeFirstOrThrow: { id: 'agent-1', poll_interval_seconds: 30 },
      });
      const update = chain({ execute: [] });
      const { db, updateTable } = createDbMock({
        selectFrom: noGlobal(select),
        insertInto: insert,
        updateTable: update,
      });
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

      await expect(service.getGlobalEnrollment()).resolves.toEqual({
        enabled: false,
        token: null,
      });
    });

    it('exposes rollout commands with a name placeholder when enabled', async () => {
      const { db } = createDbMock({
        selectFrom: storedGlobal('SECRET-GLOBAL'),
      });
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

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
      const service = new AgentsService(db, crypto, targets, notifications);

      await expect(
        service.enroll({ token: 'GLOBAL-TOK', agentName: '  ' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
