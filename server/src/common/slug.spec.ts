import { chain, createDbMock } from '../testing/db-mock';
import { isUuid, slugify, uniqueSlug } from './slug';

describe('slugify', () => {
  it('lowercases and kebab-cases names', () => {
    expect(slugify('Daily Backup')).toBe('daily-backup');
    expect(slugify('  Offsite: S3 (eu)  ')).toBe('offsite-s3-eu');
    expect(slugify('foo_bar--baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('--hello--')).toBe('hello');
    expect(slugify('(new) repo!')).toBe('new-repo');
  });

  it('falls back to entity when no usable characters remain', () => {
    expect(slugify('!!!')).toBe('entity');
    expect(slugify('备份')).toBe('entity');
    expect(slugify('')).toBe('entity');
  });
});

describe('isUuid', () => {
  it('accepts canonical UUIDs (any case)', () => {
    expect(isUuid('3f6f8b2e-7c4a-4b1d-9e2f-1a2b3c4d5e6f')).toBe(true);
    expect(isUuid('3F6F8B2E-7C4A-4B1D-9E2F-1A2B3C4D5E6F')).toBe(true);
  });

  it('rejects slugs and malformed ids', () => {
    expect(isUuid('daily-backup')).toBe(false);
    expect(isUuid('3f6f8b2e7c4a4b1d9e2f1a2b3c4d5e6f')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the base slug when it is free', async () => {
    const select = chain({ execute: [] });
    const { db } = createDbMock({ selectFrom: select });

    await expect(uniqueSlug(db, 'targets', 'Daily Backup')).resolves.toBe(
      'daily-backup',
    );
  });

  it('suffixes with the next free number on collision', async () => {
    const select = chain({
      execute: [{ slug: 'daily-backup' }, { slug: 'daily-backup-2' }],
    });
    const { db } = createDbMock({ selectFrom: select });

    await expect(uniqueSlug(db, 'targets', 'Daily Backup')).resolves.toBe(
      'daily-backup-3',
    );
  });

  it('ignores non-numeric lookalikes', async () => {
    const select = chain({ execute: [{ slug: 'daily-backup-x' }] });
    const { db } = createDbMock({ selectFrom: select });

    await expect(uniqueSlug(db, 'targets', 'Daily Backup')).resolves.toBe(
      'daily-backup',
    );
  });

  it('excludes the row being renamed from the collision check', async () => {
    const select = chain({ execute: [] });
    const { db } = createDbMock({ selectFrom: select });

    await uniqueSlug(db, 'targets', 'Daily Backup', 'row-id');

    expect(select.where).toHaveBeenCalledWith('id', '!=', 'row-id');
  });
});
