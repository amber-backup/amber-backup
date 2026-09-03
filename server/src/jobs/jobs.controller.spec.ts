import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { SchedulerService } from './scheduler.service';
import { JobRunnerService } from './job-runner.service';
import { TargetsService } from '../targets/targets.service';
import { ResticService } from '../restic/restic.service';
import { SlugResolverService } from '../common/slug-resolver.service';
import { RequestUser } from '../common/auth/request-user';
import { BackupJobRow } from '../database/database.types';

describe('JobsController', () => {
  const user = { id: 'u1' } as RequestUser;

  function make(job: Partial<BackupJobRow>) {
    const row = {
      id: 'job-1',
      cron_expr: '0 3 * * *',
      credential_secret_id: null,
      ...job,
    } as BackupJobRow;
    const jobs = {
      list: jest.fn().mockResolvedValue([row]),
      get: jest.fn().mockResolvedValue(row),
      nextRun: jest.fn().mockReturnValue(null),
    };
    const targets = {
      get: jest.fn().mockResolvedValue({}),
      resolveRepoAdHoc: jest.fn().mockResolvedValue({}),
    };
    const restic = { testConnection: jest.fn().mockResolvedValue({ ok: true }) };
    const slugs = { resolve: jest.fn().mockResolvedValue('job-1') };
    const controller = new JobsController(
      jobs as unknown as JobsService,
      {} as SchedulerService,
      {} as JobRunnerService,
      targets as unknown as TargetsService,
      restic as unknown as ResticService,
      slugs as unknown as SlugResolverService,
    );
    return { controller, targets };
  }

  it('reports whether a job overrides the connection credentials', async () => {
    const withOverride = make({ credential_secret_id: 'sec-1' });
    const without = make({ credential_secret_id: null });

    expect(await withOverride.controller.get(user, 'job-1')).toMatchObject({
      has_credential_override: true,
    });
    expect(await without.controller.get(user, 'job-1')).toMatchObject({
      has_credential_override: false,
    });
    expect(await without.controller.list(user)).toEqual([
      expect.objectContaining({ has_credential_override: false }),
    ]);
  });

  it('never exposes the override secret id', async () => {
    const { controller } = make({ credential_secret_id: 'sec-1' });

    expect(await controller.get(user, 'job-1')).not.toHaveProperty(
      'credential_secret_id',
    );
  });

  it('applies a credential override when testing an unsaved repository', async () => {
    const { controller, targets } = make({});

    await controller.testRepo(user, {
      targetId: 't1',
      repoConfig: { path: 'repo' },
      repoCredentials: { username: 'probe' },
      repoPassword: 'pw',
    } as never);

    expect(targets.resolveRepoAdHoc).toHaveBeenCalledWith(
      expect.objectContaining({ repoCredentials: { username: 'probe' } }),
    );
  });
});
