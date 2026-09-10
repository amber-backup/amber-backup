import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Db, KYSELY } from '../database/database.module';
import { AuthSource, User } from '../database/database.types';
import { loadConfig } from '../config/configuration';
import { SettingsService } from '../settings/settings.service';
import { CreateGrantDto, CreateUserDto, UpdateUserDto } from './dto/auth.dto';

export type PublicUser = Omit<
  User,
  | 'password_hash'
  | 'totp_secret_ciphertext'
  | 'totp_secret_nonce'
  | 'totp_recovery_codes'
>;

function toPublic(user: User): PublicUser {
  const {
    password_hash: _pw,
    totp_secret_ciphertext: _tc,
    totp_secret_nonce: _tn,
    totp_recovery_codes: _rc,
    ...rest
  } = user;
  return rest;
}

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /** Creates the bootstrap admin on first start when no users exist. */
  async onModuleInit(): Promise<void> {
    const config = loadConfig();
    if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) return;
    const existing = await this.db
      .selectFrom('users')
      .select('id')
      .limit(1)
      .executeTakeFirst();
    if (existing) return;

    await this.create(
      {
        email: config.bootstrapAdminEmail,
        displayName: 'Administrator',
        password: config.bootstrapAdminPassword,
        isAdmin: true,
      },
      'local',
    );
    this.logger.log(`Bootstrap admin created: ${config.bootstrapAdminEmail}`);
  }

  async list(): Promise<PublicUser[]> {
    const rows = await this.db
      .selectFrom('users')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(toPublic);
  }

  async findById(id: string): Promise<PublicUser> {
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('User not found');
    return toPublic(user);
  }

  async findByEmailRaw(email: string): Promise<User | undefined> {
    return this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email.toLowerCase())
      .executeTakeFirst();
  }

  /** Full user row (including secret columns) — for internal auth checks only. */
  async findByIdRaw(id: string): Promise<User | undefined> {
    return this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async create(
    dto: CreateUserDto,
    authSource: AuthSource = 'local',
  ): Promise<PublicUser> {
    const email = dto.email.toLowerCase();
    if (await this.findByEmailRaw(email)) {
      throw new ConflictException('Email already in use');
    }
    const passwordHash =
      authSource === 'local' ? await argon2.hash(dto.password) : null;

    const user = await this.db
      .insertInto('users')
      .values({
        email,
        display_name: dto.displayName,
        auth_source: authSource,
        password_hash: passwordHash,
        is_admin: dto.isAdmin ?? false,
        // SSO users start disabled until an admin enables them (§11).
        disabled: authSource !== 'local',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPublic(user);
  }

  async update(id: string, dto: UpdateUserDto): Promise<PublicUser> {
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('User not found');

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (dto.displayName !== undefined) patch.display_name = dto.displayName;
    if (dto.isAdmin !== undefined) patch.is_admin = dto.isAdmin;
    if (dto.disabled !== undefined) patch.disabled = dto.disabled;

    const wasLocal = user.auth_source === 'local';
    const willBeLocal =
      dto.authSource === undefined ? wasLocal : dto.authSource === 'local';

    if (willBeLocal !== wasLocal) {
      if (willBeLocal) {
        // Without a password the account would have no way in at all.
        if (!dto.password) {
          throw new BadRequestException(
            'A password is required to switch this account to local login',
          );
        }
        patch.auth_source = 'local';
      } else {
        if (!(await this.settings.hasUsableSso())) {
          throw new BadRequestException(
            'Enable SSO with at least one fully configured provider before switching accounts to it',
          );
        }
        patch.auth_source = 'sso';
        patch.password_hash = null;
        // The local second factors belong to the password, so they go with it —
        // otherwise switching back later would resurrect a stale TOTP secret.
        patch.totp_enabled = false;
        patch.totp_secret_ciphertext = null;
        patch.totp_secret_nonce = null;
        patch.totp_recovery_codes = null;
      }
    }

    if (dto.password !== undefined) {
      if (!willBeLocal) {
        throw new BadRequestException('Cannot set password on SSO account');
      }
      patch.password_hash = await argon2.hash(dto.password);
    }

    const updated = await this.db
      .updateTable('users')
      .set(patch)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPublic(updated);
  }

  async enable(id: string): Promise<PublicUser> {
    return this.update(id, { disabled: false });
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('users').where('id', '=', id).execute();
  }

  // --- Grants ---------------------------------------------------------------

  async listGrants(userId: string) {
    return this.db
      .selectFrom('resource_grants')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
  }

  async addGrant(userId: string, dto: CreateGrantDto) {
    await this.findById(userId); // ensure exists
    return this.db
      .insertInto('resource_grants')
      .values({
        user_id: userId,
        resource_type: dto.resourceType,
        resource_id: dto.resourceId,
        access_level: dto.accessLevel,
      })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'resource_type', 'resource_id'])
          .doUpdateSet({ access_level: dto.accessLevel }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async removeGrant(userId: string, grantId: string): Promise<void> {
    await this.db
      .deleteFrom('resource_grants')
      .where('id', '=', grantId)
      .where('user_id', '=', userId)
      .execute();
  }

  // --- SSO identities -------------------------------------------------------

  /** The user an SSO provider's subject is bound to, if any. */
  async findBySsoIdentity(
    providerId: string,
    subject: string,
  ): Promise<User | undefined> {
    return this.db
      .selectFrom('users')
      .innerJoin('sso_identities', 'sso_identities.user_id', 'users.id')
      .where('sso_identities.provider_id', '=', providerId)
      .where('sso_identities.subject', '=', subject)
      .selectAll('users')
      .executeTakeFirst();
  }

  /** Binds a provider's subject to a user; re-linking is a no-op. */
  async linkSsoIdentity(
    userId: string,
    providerId: string,
    subject: string,
  ): Promise<void> {
    await this.db
      .insertInto('sso_identities')
      .values({ user_id: userId, provider_id: providerId, subject })
      .onConflict((oc) =>
        oc.columns(['provider_id', 'subject']).doUpdateSet({ user_id: userId }),
      )
      .execute();
  }

  async touchSsoIdentity(providerId: string, subject: string): Promise<void> {
    await this.db
      .updateTable('sso_identities')
      .set({ last_login_at: new Date() })
      .where('provider_id', '=', providerId)
      .where('subject', '=', subject)
      .execute();
  }

  async verifyPassword(user: User, password: string): Promise<boolean> {
    if (!user.password_hash) return false;
    try {
      return await argon2.verify(user.password_hash, password);
    } catch {
      return false;
    }
  }

  /** Lets a user change their own local password after confirming the current one. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('User not found');
    if (user.auth_source !== 'local') {
      throw new BadRequestException(
        'Password is managed by your identity provider',
      );
    }
    if (!(await this.verifyPassword(user, currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.db
      .updateTable('users')
      .set({ password_hash: await argon2.hash(newPassword), updated_at: new Date() })
      .where('id', '=', userId)
      .execute();
  }
}
