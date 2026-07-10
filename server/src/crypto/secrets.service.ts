import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Db, KYSELY } from '../database/database.module';
import { SecretType } from '../database/database.types';
import { CryptoService } from './crypto.service';

/**
 * Stores and retrieves encrypted secrets (repo passwords, backend credentials).
 * Plaintext exists only transiently while a restic call is prepared.
 */
@Injectable()
export class SecretsService {
  constructor(
    @Inject(KYSELY) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  async create(type: SecretType, plaintext: string): Promise<string> {
    const { ciphertext, nonce } = this.crypto.encrypt(plaintext);
    const row = await this.db
      .insertInto('secrets')
      .values({ type, ciphertext, nonce })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async update(id: string, plaintext: string): Promise<void> {
    const { ciphertext, nonce } = this.crypto.encrypt(plaintext);
    await this.db
      .updateTable('secrets')
      .set({ ciphertext, nonce })
      .where('id', '=', id)
      .execute();
  }

  async reveal(id: string): Promise<string> {
    const row = await this.db
      .selectFrom('secrets')
      .select(['ciphertext', 'nonce'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`Secret ${id} not found`);
    return this.crypto.decrypt(row);
  }

  async revealOptional(id: string | null): Promise<string | null> {
    if (!id) return null;
    return this.reveal(id);
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('secrets').where('id', '=', id).execute();
  }
}
