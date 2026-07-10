import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Db, KYSELY } from '../database/database.module';
import { AuthSource, User } from '../database/database.types';
import { loadConfig } from '../config/configuration';
import { CreateGrantDto, CreateUserDto, UpdateUserDto } from './dto/auth.dto';

export type PublicUser = Omit<User, 'password_hash'>;

function toPublic(user: User): PublicUser {
  const { password_hash: _omit, ...rest } = user;
  return rest;
}

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(@Inject(KYSELY) private readonly db: Db) {}

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
    if (dto.password !== undefined) {
      if (user.auth_source !== 'local') {
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

  async verifyPassword(user: User, password: string): Promise<boolean> {
    if (!user.password_hash) return false;
    try {
      return await argon2.verify(user.password_hash, password);
    } catch {
      return false;
    }
  }
}
