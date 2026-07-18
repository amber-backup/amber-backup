import { NotFoundException } from '@nestjs/common';
import { chain, createDbMock } from '../testing/db-mock';
import { SlugResolverService } from './slug-resolver.service';

describe('SlugResolverService', () => {
  const UUID = '3f6f8b2e-7c4a-4b1d-9e2f-1a2b3c4d5e6f';

  it('passes a UUID through without touching the database', async () => {
    const { db, selectFrom } = createDbMock({});
    const resolver = new SlugResolverService(db);

    await expect(resolver.resolve('targets', UUID)).resolves.toBe(UUID);
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('resolves a slug to its row id', async () => {
    const select = chain({ executeTakeFirst: { id: UUID } });
    const { db, selectFrom } = createDbMock({ selectFrom: select });
    const resolver = new SlugResolverService(db);

    await expect(resolver.resolve('targets', 'daily-backup')).resolves.toBe(
      UUID,
    );
    expect(selectFrom).toHaveBeenCalledWith('targets');
    expect(select.where).toHaveBeenCalledWith('slug', '=', 'daily-backup');
  });

  it('throws NotFound for an unknown slug', async () => {
    const { db } = createDbMock({
      selectFrom: chain({ executeTakeFirst: undefined }),
    });
    const resolver = new SlugResolverService(db);

    await expect(resolver.resolve('targets', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
