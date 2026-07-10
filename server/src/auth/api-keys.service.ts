import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { CryptoService } from '../crypto/crypto.service';
import { ApiKeyScopes } from '../database/database.types';
import { API_KEY_PREFIX } from '../common/guards/auth.guard';
import { CreateApiKeyDto } from './dto/auth.dto';

export interface CreatedApiKey {
  id: string;
  name: string;
  /** Full plaintext key — shown only once. */
  key: string;
  prefix: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  async list(userId: string) {
    return this.db
      .selectFrom('api_keys')
      .select([
        'id',
        'name',
        'prefix',
        'scopes',
        'expires_at',
        'last_used_at',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async create(userId: string, dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    const secret = this.crypto.generateToken(24);
    const key = `${API_KEY_PREFIX}${secret}`;
    const prefix = key.slice(0, 12);
    const scopes: ApiKeyScopes = dto.scopes ?? { actions: ['*'] };
    const expiresAt = dto.expiresInDays
      ? new Date(Date.now() + dto.expiresInDays * 86400_000)
      : null;

    const row = await this.db
      .insertInto('api_keys')
      .values({
        user_id: userId,
        name: dto.name,
        key_hash: this.crypto.hashToken(key),
        prefix,
        scopes: JSON.stringify(scopes),
        expires_at: expiresAt,
      })
      .returning(['id', 'name', 'prefix'])
      .executeTakeFirstOrThrow();

    return { id: row.id, name: row.name, prefix: row.prefix, key };
  }

  async remove(userId: string, keyId: string): Promise<void> {
    const res = await this.db
      .deleteFrom('api_keys')
      .where('id', '=', keyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!res.numDeletedRows) throw new NotFoundException('API key not found');
  }
}
