import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { chain, createDbMock } from '../testing/db-mock';
import { AdminIpAllowlistService } from './admin-ip-allowlist.service';

describe('AdminIpAllowlistService', () => {
  const ENV = process.env.ADMIN_ALLOWED_IPS;

  afterEach(() => {
    if (ENV === undefined) delete process.env.ADMIN_ALLOWED_IPS;
    else process.env.ADMIN_ALLOWED_IPS = ENV;
  });

  function build(stored: string[] | null) {
    const select = chain({
      executeTakeFirst: stored ? { value: { entries: stored } } : undefined,
    });
    const insert = chain();
    const { db } = createDbMock({ selectFrom: select, insertInto: insert });
    return { service: new AdminIpAllowlistService(db), insert };
  }

  it('allows any address while both lists are empty', async () => {
    delete process.env.ADMIN_ALLOWED_IPS;
    const { service } = build(null);
    await expect(service.isAllowed('198.51.100.4')).resolves.toBe(true);
  });

  it('combines ADMIN_ALLOWED_IPS with the stored entries', async () => {
    process.env.ADMIN_ALLOWED_IPS = '10.0.0.0/8, 203.0.113.7';
    const { service } = build(['192.0.2.0/24']);
    await expect(service.isAllowed('10.4.5.6')).resolves.toBe(true);
    await expect(service.isAllowed('203.0.113.7')).resolves.toBe(true);
    await expect(service.isAllowed('::ffff:192.0.2.55')).resolves.toBe(true);
    await expect(service.isAllowed('198.51.100.4')).resolves.toBe(false);
    await expect(
      service.assertAllowed('198.51.100.4', 'admin@x'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('shows env and stored entries separately with the caller address', async () => {
    process.env.ADMIN_ALLOWED_IPS = '10.0.0.0/8';
    const { service } = build(['192.0.2.1']);
    await expect(service.view('::ffff:10.0.0.3')).resolves.toEqual({
      entries: ['192.0.2.1'],
      envEntries: ['10.0.0.0/8'],
      currentIp: '10.0.0.3',
    });
  });

  it('saves a list that keeps the caller allowed', async () => {
    delete process.env.ADMIN_ALLOWED_IPS;
    const { service, insert } = build(null);
    const view = await service.update([' 10.0.0.0/8 ', '10.0.0.0/8', ''], '10.1.1.1');
    expect(view.entries).toEqual(['10.0.0.0/8']);
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ value: JSON.stringify({ entries: ['10.0.0.0/8'] }) }),
    );
    // The cache reflects the write without another read.
    await expect(service.isAllowed('192.0.2.1')).resolves.toBe(false);
  });

  it('refuses a list that would lock the caller out', async () => {
    delete process.env.ADMIN_ALLOWED_IPS;
    const { service, insert } = build(null);
    await expect(service.update(['10.0.0.0/8'], '192.0.2.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(insert.values).not.toHaveBeenCalled();
  });

  it('allows clearing the list', async () => {
    delete process.env.ADMIN_ALLOWED_IPS;
    const { service } = build(['10.0.0.0/8']);
    await expect(service.update([], '192.0.2.1')).resolves.toMatchObject({ entries: [] });
  });

  it('rejects invalid entries', async () => {
    delete process.env.ADMIN_ALLOWED_IPS;
    const { service } = build(null);
    await expect(service.update(['intranet'], '10.0.0.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
