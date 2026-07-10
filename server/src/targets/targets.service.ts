import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { SecretsService } from '../crypto/secrets.service';
import { AccessControlService } from '../common/access-control.service';
import { RequestUser } from '../common/auth/request-user';
import { Target } from '../database/database.types';
import {
  CredentialFile,
  getBackend,
  splitConfig,
} from './backend-registry';
import { CreateTargetDto, UpdateTargetDto } from './dto/target.dto';

/** A fully resolved repository ready to hand to restic (server or agent). */
export interface ResolvedTarget {
  targetId: string;
  repository: string;
  password: string;
  env: Record<string, string>;
  credentialFiles: CredentialFile[];
}

export type PublicTarget = Omit<
  Target,
  'password_secret_id' | 'credential_secret_id'
>;

@Injectable()
export class TargetsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly secrets: SecretsService,
    private readonly acl: AccessControlService,
  ) {}

  private toPublic(t: Target): PublicTarget {
    const { password_secret_id, credential_secret_id, ...rest } = t;
    void password_secret_id;
    void credential_secret_id;
    return rest;
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
    const { config, credentials } = splitConfig(dto.backendType, dto.config);

    const passwordSecretId = await this.secrets.create(
      'repo_password',
      dto.repoPassword,
    );
    const credentialSecretId =
      Object.keys(credentials).length > 0
        ? await this.secrets.create('backend_credential', JSON.stringify(credentials))
        : null;

    const row = await this.db
      .insertInto('targets')
      .values({
        name: dto.name,
        backend_type: dto.backendType,
        config: JSON.stringify(config),
        password_secret_id: passwordSecretId,
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
    if (dto.repoPassword !== undefined) {
      await this.secrets.update(target.password_secret_id, dto.repoPassword);
    }
    if (dto.config !== undefined) {
      const { config, credentials } = splitConfig(target.backend_type, dto.config);
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
    await this.db.deleteFrom('targets').where('id', '=', id).execute();
    await this.secrets.remove(target.password_secret_id);
    if (target.credential_secret_id) {
      await this.secrets.remove(target.credential_secret_id);
    }
  }

  /** Resolves a target to a repository + secrets. Internal use (executor/agent). */
  async resolve(id: string): Promise<ResolvedTarget> {
    const target = await this.getRow(id);
    const password = await this.secrets.reveal(target.password_secret_id);
    const credentials: Record<string, string> = target.credential_secret_id
      ? JSON.parse(await this.secrets.reveal(target.credential_secret_id))
      : {};
    const backend = getBackend(target.backend_type);
    const config =
      typeof target.config === 'string'
        ? JSON.parse(target.config)
        : target.config;
    const resolved = backend.build(config, credentials);
    return {
      targetId: id,
      repository: resolved.repository,
      password,
      env: resolved.env,
      credentialFiles: resolved.credentialFiles,
    };
  }

  /** Ensures the user may operate a target (used by backup/restore flows). */
  async assertOperate(user: RequestUser, id: string): Promise<void> {
    if (!(await this.acl.can(user, 'target', id, 'operate'))) {
      throw new ForbiddenException('Missing operate access on target');
    }
  }

  /** Builds a resolved repository from an unsaved form payload (pre-save test). */
  resolveAdHoc(dto: CreateTargetDto): ResolvedTarget {
    const { config, credentials } = splitConfig(dto.backendType, dto.config);
    const backend = getBackend(dto.backendType);
    const resolved = backend.build(config, credentials);
    return {
      targetId: 'adhoc',
      repository: resolved.repository,
      password: dto.repoPassword,
      env: resolved.env,
      credentialFiles: resolved.credentialFiles,
    };
  }
}
