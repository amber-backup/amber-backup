import { chain, createDbMock } from '../testing/db-mock';
import { AuditService } from './audit.service';

describe('AuditService retention purge', () => {
  const origEnv = process.env.AUDIT_RETENTION_DAYS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AUDIT_RETENTION_DAYS;
    else process.env.AUDIT_RETENTION_DAYS = origEnv;
  });

  it('deletes entries older than the configured retention window', async () => {
    process.env.AUDIT_RETENTION_DAYS = '30';
    const del = chain({ executeTakeFirst: { numDeletedRows: 5n } });
    const { db, deleteFrom } = createDbMock({ deleteFrom: del });
    const service = new AuditService(db);

    await service.purgeExpired();

    expect(deleteFrom).toHaveBeenCalledWith('audit_log');
    const [col, op, cutoff] = del.where.mock.calls[0];
    expect(col).toBe('created_at');
    expect(op).toBe('<');
    const ageDays = (Date.now() - (cutoff as Date).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);
  });

  it('defaults to a 90-day window when unset', async () => {
    delete process.env.AUDIT_RETENTION_DAYS;
    const del = chain({ executeTakeFirst: { numDeletedRows: 0n } });
    const { db } = createDbMock({ deleteFrom: del });

    await new AuditService(db).purgeExpired();

    const cutoff = del.where.mock.calls[0][2] as Date;
    const ageDays = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(89.9);
    expect(ageDays).toBeLessThan(90.1);
  });

  it('does nothing when retention is disabled (<= 0)', async () => {
    process.env.AUDIT_RETENTION_DAYS = '0';
    const del = chain({ executeTakeFirst: { numDeletedRows: 0n } });
    const { db, deleteFrom } = createDbMock({ deleteFrom: del });

    await new AuditService(db).purgeExpired();

    expect(deleteFrom).not.toHaveBeenCalled();
  });
});
