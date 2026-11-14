import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestoreRunnerService } from './restore-runner.service';
import { ResticService } from '../restic/restic.service';
import { TargetsService } from '../targets/targets.service';
import { chain, createDbMock } from '../testing/db-mock';

const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

describe('RestoreRunnerService download cleanup', () => {
  let tmp: string;
  const prevTmp = process.env.RESTORE_TMP_DIR;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-restore-spec-'));
    process.env.RESTORE_TMP_DIR = tmp;
  });
  afterEach(async () => {
    if (prevTmp === undefined) delete process.env.RESTORE_TMP_DIR;
    else process.env.RESTORE_TMP_DIR = prevTmp;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const exists = (p: string) =>
    fs.access(p).then(
      () => true,
      () => false,
    );

  it('deletes expired archives and clears their reference', async () => {
    const archive = path.join(tmp, `restore-${RUN}.tar.gz`);
    await fs.writeFile(archive, 'data');
    const update = chain();
    const { db } = createDbMock({
      selectFrom: chain({
        execute: [{ id: RUN, destination: { downloadRef: archive } }],
      }),
      updateTable: update,
    });
    const service = new RestoreRunnerService(db, {} as ResticService, {} as TargetsService);

    expect(await service.sweepExpiredDownloads()).toBe(1);

    expect(await exists(archive)).toBe(false);
    expect(JSON.parse(update.set.mock.calls[0][0].destination)).toEqual({
      downloadRef: null,
    });
    expect(update.where).toHaveBeenCalledWith('id', '=', RUN);
  });

  it('removes orphaned restore dirs and archives on boot, keeping live downloads', async () => {
    const live = path.join(tmp, `restore-${RUN}.tar.gz`);
    const orphanDir = path.join(tmp, `restore-${OTHER}`);
    const orphanArchive = path.join(tmp, `restore-${OTHER}.tar.gz`);
    const unrelated = path.join(tmp, 'keep-me.txt');
    await fs.writeFile(live, 'x');
    await fs.mkdir(orphanDir);
    await fs.writeFile(path.join(orphanDir, 'secret.txt'), 'plain');
    await fs.writeFile(orphanArchive, 'half');
    await fs.writeFile(unrelated, 'x');
    const { db } = createDbMock({
      selectFrom: chain({ execute: [{ destination: { downloadRef: live } }] }),
    });
    const service = new RestoreRunnerService(db, {} as ResticService, {} as TargetsService);

    const removed = await service.removeOrphanedArtifacts();

    expect(removed.sort()).toEqual([`restore-${OTHER}`, `restore-${OTHER}.tar.gz`]);
    expect(await exists(live)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
    expect(await exists(orphanDir)).toBe(false);
    expect(await exists(orphanArchive)).toBe(false);
  });

  it('removes the partial restore dir when a download restore fails', async () => {
    const run = {
      id: RUN,
      mode: 'download',
      snapshot_id: 'snap',
      options: {},
      destination: {},
      included_paths: null,
    };
    const update = chain();
    const { db } = createDbMock({
      selectFrom: chain({ executeTakeFirst: run }),
      updateTable: update,
    });
    const restic = {
      restore: jest.fn(async (_ctx: unknown, _snap: string, target: string) => {
        await fs.writeFile(path.join(target, 'partial.bin'), 'decrypted');
        throw new Error('restic restore exited 1');
      }),
    };
    const targets = {
      resolveForRestore: jest.fn().mockResolvedValue({
        repository: 'r',
        password: 'p',
        env: {},
        credentialFiles: [],
      }),
    };
    const service = new RestoreRunnerService(
      db,
      restic as unknown as ResticService,
      targets as unknown as TargetsService,
    );

    await service.executeLocal(RUN);

    expect(await exists(path.join(tmp, `restore-${RUN}`))).toBe(false);
    expect(update.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', error: 'restic restore exited 1' }),
    );
  });
});
