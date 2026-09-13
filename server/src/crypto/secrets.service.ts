import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Db, KYSELY } from '../database/database.module';
import { SecretType } from '../database/database.types';
import { CryptoService } from './crypto.service';

/** AAD binding a ciphertext to its own row, so it can't be swapped between rows. */
function aadFor(id: string): string {
  return `secret:${id}`;
}

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
    // Generate the id up front so it can bind the ciphertext as AAD.
    const id = randomUUID();
    const { ciphertext, nonce } = this.crypto.encrypt(plaintext, aadFor(id));
    const row = await this.db
      .insertInto('secrets')
      .values({ id, type, ciphertext, nonce })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async update(id: string, plaintext: string): Promise<void> {
    const { ciphertext, nonce } = this.crypto.encrypt(plaintext, aadFor(id));
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
    try {
      return this.crypto.decrypt(row, aadFor(id));
    } catch {
      // Secrets written before AAD binding carry none; fall back so existing
      // deployments keep working. They upgrade to AAD-bound on the next update.
      return this.crypto.decrypt(row);
    }
  }

  async revealOptional(id: string | null): Promise<string | null> {
    if (!id) return null;
    return this.reveal(id);
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('secrets').where('id', '=', id).execute();
  }
}
