import { NotFoundException } from '@nestjs/common';
import { chain, createDbMock, TEST_MASTER_KEY } from '../testing/db-mock';

process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;

import { CryptoService } from './crypto.service';
import { SecretsService } from './secrets.service';

describe('SecretsService (envelope encryption at rest)', () => {
  let crypto: CryptoService;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = TEST_MASTER_KEY;
    crypto = new CryptoService();
  });

  it('encrypts the plaintext before persisting it', async () => {
    const insert = chain({ executeTakeFirstOrThrow: { id: 'sec-1' } });
    const { db } = createDbMock({ insertInto: insert });
    const service = new SecretsService(db, crypto);

    const id = await service.create('repo_password', 'hunter2');

    expect(id).toBe('sec-1');
    const stored = insert.values.mock.calls[0][0] as {
      type: string;
      ciphertext: string;
      nonce: string;
    };
    expect(stored.type).toBe('repo_password');
    // The stored row must not contain the plaintext anywhere.
    expect(stored.ciphertext).not.toContain('hunter2');
    expect(stored.nonce).toBeTruthy();
    // …but must decrypt back to it.
    expect(crypto.decrypt(stored)).toBe('hunter2');
  });

  it('reveal() decrypts the stored ciphertext', async () => {
    const payload = crypto.encrypt('backend-credential');
    const select = chain({ executeTakeFirst: payload });
    const { db } = createDbMock({ selectFrom: select });
    const service = new SecretsService(db, crypto);

    await expect(service.reveal('sec-1')).resolves.toBe('backend-credential');
  });

  it('reveal() throws NotFoundException for a missing secret', async () => {
    const select = chain({ executeTakeFirst: undefined });
    const { db } = createDbMock({ selectFrom: select });
    const service = new SecretsService(db, crypto);

    await expect(service.reveal('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('revealOptional(null) resolves to null without touching the DB', async () => {
    const { db, selectFrom } = createDbMock({});
    const service = new SecretsService(db, crypto);

    await expect(service.revealOptional(null)).resolves.toBeNull();
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('re-encrypts on update (fresh nonce, no plaintext stored)', async () => {
    const update = chain({ execute: [] });
    const { db } = createDbMock({ updateTable: update });
    const service = new SecretsService(db, crypto);

    await service.update('sec-1', 'rotated-secret');

    const stored = update.set.mock.calls[0][0] as {
      ciphertext: string;
      nonce: string;
    };
    expect(stored.ciphertext).not.toContain('rotated-secret');
    expect(crypto.decrypt(stored)).toBe('rotated-secret');
  });
});
