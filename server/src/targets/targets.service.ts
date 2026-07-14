import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { SecretsService } from '../crypto/secrets.service';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { Repository, RestoreRun, Target } from '../database/database.types';
import {
  CredentialFile,
  getBackend,
  splitConfig,
} from './backend-registry';
import { SshKeyService } from './ssh-key.service';
import { CreateTargetDto, UpdateTargetDto } from './dto/target.dto';

/** A fully resolved repository ready to hand to restic (server or agent). */
export interface ResolvedTarget {
  targetId: string;
  repository: string;
  password: string;
  env: Record<string, string>;
  credentialFiles: CredentialFile[];
  extraArgs?: string[];
}

/** Inputs for an ad-hoc repository resolution (pre-save connection/repo test). */
export interface AdHocRepoInput {
  /** Saved connection to use; omit for a pre-save target or a local repo. */
  targetId?: string | null;
  /** Backend type for a pre-save target (ignored when `targetId` is set). */
  backendType?: string;
  /** Flat connection form values for a pre-save target. */
  targetConfig?: Record<string, unknown>;
  /** Repository-specific values (bucket, prefix, path). */
  repoConfig?: Record<string, unknown>;
  repoPassword: string;
}

export type PublicTarget = Omit<Target, 'credential_secret_id'>;

@Injectable()
export class TargetsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly secrets: SecretsService,
    private readonly acl: AccessControlService,
    private readonly sshKeys: SshKeyService,
  ) {}

  private toPublic(t: Target): PublicTarget {
    const { credential_secret_id, ...rest } = t;
    void credential_secret_id;
    return rest;
  }

  private parseConfig(c: unknown): Record<string, unknown> {
    if (c == null) return {};
    return typeof c === 'string'
      ? (JSON.parse(c) as Record<string, unknown>)
      : (c as Record<string, unknown>);
  }

  async list(user: RequestUser): Promise<PublicTarget[]> {
    const ids = await this.acl.visibleResourceIds(user, 'target');
    let q = this.db.selectFrom('targets').selectAll().orderBy('name', 'asc');
    if (ids !== 'all') {
      if (ids.length === 0) return [];
      q = q.where('id', 'in', ids);
    }
    return (await q.execute()).map((t) => this.toPublic(t));
  }

  async getRow(id: string): Promise<Target> {
    const t = await this.db
      .selectFrom('targets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!t) throw new NotFoundException('Target not found');
    return t;
  }

  async get(user: RequestUser, id: string): Promise<PublicTarget> {
    await this.acl.assert(user, 'target', id, 'view');
    return this.toPublic(await this.getRow(id));
  }

  async create(user: RequestUser, dto: CreateTargetDto): Promise<PublicTarget> {
    getBackend(dto.backendType); // validate type
    const { config, credentials } = splitConfig(
      dto.backendType,
      dto.config,
      'target',
    );

    // SFTP authenticates with a server-generated key pair: keep the private key
    // in the encrypted credential secret and expose the public key (non-secret)
    // via the target config so the user can install it on the SSH server. The
    // key now belongs to the connection (host/user live on the target), so it is
    // generated once here and reused by every repository on this connection.
    if (dto.backendType === 'sftp' && !credentials.privateKey) {
      const pair = await this.sshKeys.generate(`amber-backup:${dto.name}`);
      credentials.privateKey = pair.privateKey;
      config.publicKey = pair.publicKey;
    }

    const credentialSecretId =
      Object.keys(credentials).length > 0
        ? await this.secrets.create(
            'backend_credential',
            JSON.stringify(credentials),
          )
        : null;

    const row = await this.db
      .insertInto('targets')
      .values({
        name: dto.name,
        backend_type: dto.backendType,
        config: JSON.stringify(config),
        credential_secret_id: credentialSecretId,
        owner_id: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Owner implicitly manages their target.
    if (!user.isAdmin) {
      await this.db
        .insertInto('resource_grants')
        .values({
          user_id: user.id,
          resource_type: 'target',
          resource_id: row.id,
          access_level: 'manage',
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    return this.toPublic(row);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateTargetDto,
  ): Promise<PublicTarget> {
    await this.acl.assert(user, 'target', id, 'manage');
    const target = await this.getRow(id);
    const patch: Record<string, unknown> = { updated_at: new Date() };

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.config !== undefined) {
      const { config, credentials } = splitConfig(
        target.backend_type,
        dto.config,
        'target',
      );
      // The SFTP public key lives in config but isn't an editable form field —
      // carry it (and thereby its key pair) across an edit. The private key in
      // the credential secret is untouched because SFTP has no secret fields.
      if (target.backend_type === 'sftp') {
        const existing = this.parseConfig(target.config);
        if (existing?.publicKey) config.publicKey = existing.publicKey;
      }
      patch.config = JSON.stringify(config);
      if (Object.keys(credentials).length > 0) {
        if (target.credential_secret_id) {
          await this.secrets.update(
            target.credential_secret_id,
            JSON.stringify(credentials),
          );
        } else {
          patch.credential_secret_id = await this.secrets.create(
            'backend_credential',
            JSON.stringify(credentials),
          );
        }
      }
    }

    const row = await this.db
      .updateTable('targets')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toPublic(row);
  }

  async remove(user: RequestUser, id: string): Promise<void> {
    await this.acl.assert(user, 'target', id, 'manage');
    const target = await this.getRow(id);

    // A connection is shared: refuse to delete it while repositories still live
    // on it (the DB FK also enforces this via ON DELETE RESTRICT — this is the
    // friendly error).
    const inUse = await this.db
      .selectFrom('repositories')
      .select('id')
      .where('target_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    if (inUse) {
      throw new ConflictException(
        'This connection is still used by one or more backup jobs',
      );
    }

    await this.db.deleteFrom('targets').where('id', '=', id).execute();
    if (target.credential_secret_id) {
      await this.secrets.remove(target.credential_secret_id);
    }
  }

  /** Assembles a ResolvedTarget from already-decrypted parts. */
  private assemble(
    backendType: string,
    config: Record<string, unknown>,
    credentials: Record<string, string>,
    repoConfig: Record<string, unknown>,
    password: string,
    targetId: string,
  ): ResolvedTarget {
    const b = getBackend(backendType).build(config, credentials, repoConfig);
    return {
      targetId,
      repository: b.repository,
      password,
      env: b.env,
      credentialFiles: b.credentialFiles,
      extraArgs: b.extraArgs,
    };
  }

  /**
   * Core resolver: combines a (nullable) connection with a repository's config
   * and password secret. `targetId === null` is a local filesystem repository.
   */
  private async resolveRepo(
    targetId: string | null,
    repoConfig: Record<string, unknown>,
    repoPasswordSecretId: string,
  ): Promise<ResolvedTarget> {
    const password = await this.secrets.reveal(repoPasswordSecretId);
    if (targetId == null) {
      return this.assemble('local', {}, {}, repoConfig, password, 'local');
    }
    const t = await this.getRow(targetId);
    const credentials: Record<string, string> = t.credential_secret_id
      ? JSON.parse(await this.secrets.reveal(t.credential_secret_id))
      : {};
    return this.assemble(
      t.backend_type,
      this.parseConfig(t.config),
      credentials,
      repoConfig,
      password,
      targetId,
    );
  }

  /** Resolves the repository a backup job writes to. */
  async resolveForJob(
    repo: Pick<
      Repository,
      'target_id' | 'repo_config' | 'repo_password_secret_id'
    >,
  ): Promise<ResolvedTarget> {
    return this.resolveRepo(
      repo.target_id,
      this.parseConfig(repo.repo_config),
      repo.repo_password_secret_id,
    );
  }

  /** Resolves the repository a restore run reads from. */
  async resolveForRestore(
    run: Pick<
      RestoreRun,
      'target_id' | 'repo_config' | 'repo_password_secret_id'
    >,
  ): Promise<ResolvedTarget> {
    return this.resolveRepo(
      run.target_id,
      this.parseConfig(run.repo_config),
      run.repo_password_secret_id,
    );
  }

  /**
   * Resolves a repository from an unsaved form payload (pre-save connection/repo
   * test). Handles a saved connection (`targetId`), a pre-save connection
   * (`backendType` + `targetConfig`), or a local repo (neither).
   */
  async resolveRepoAdHoc(input: AdHocRepoInput): Promise<ResolvedTarget> {
    const repoConfig = input.repoConfig ?? {};
    if (input.targetId) {
      const t = await this.getRow(input.targetId);
      const credentials: Record<string, string> = t.credential_secret_id
        ? JSON.parse(await this.secrets.reveal(t.credential_secret_id))
        : {};
      return this.assemble(
        t.backend_type,
        this.parseConfig(t.config),
        credentials,
        repoConfig,
        input.repoPassword,
        t.id,
      );
    }
    const backendType = input.backendType ?? 'local';
    const { config, credentials } = splitConfig(
      backendType,
      input.targetConfig ?? {},
      'target',
    );
    return this.assemble(
      backendType,
      config,
      credentials,
      repoConfig,
      input.repoPassword,
      'adhoc',
    );
  }

  /** Ensures the user may operate a target (used by backup/restore flows). */
  async assertOperate(user: RequestUser, id: string): Promise<void> {
    if (!(await this.acl.can(user, 'target', id, 'operate'))) {
      throw new ForbiddenException('Missing operate access on target');
    }
  }
}
