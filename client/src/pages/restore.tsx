import { useState } from 'react';
import { api, type Job, type Snapshot, type LsEntry, type RestoreRun } from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtRelative, statusLabel } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, Field, Loading, Spinner } from '../ui/primitives';

export function Restore() {
  const { data: jobs, loading } = useAsync(() => api.get<Job[]>('/jobs'));
  const [job, setJob] = useState<Job | null>(null);
  const history = useAsync(() => api.get<RestoreRun[]>('/restores?limit=15').catch(() => [] as RestoreRun[]));

  if (loading || !jobs) return <Loading label="Loading…" />;

  return (
    <div>
      <PageHeader
        title="Restore"
        subtitle={
          job
            ? 'Browse snapshots and restore selectively or in full'
            : 'Pick a job to browse its snapshots'
        }
      />
      {job ? (
        <>
          <SnapshotsPanel job={job} onBack={() => setJob(null)} reloadHistory={history.reload} />
          <HistoryPanel runs={history.data} />
        </>
      ) : (
        <JobListPanel jobs={jobs} onSelect={setJob} />
      )}
    </div>
  );
}

function JobListPanel({ jobs, onSelect }: { jobs: Job[]; onSelect: (j: Job) => void }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{`Jobs (${jobs.length})`}</h2>
      </div>
      {jobs.length === 0 ? (
        <div className="empty">No backup jobs yet.</div>
      ) : (
        jobs.map((j) => (
          <div
            className="row"
            key={j.id}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(j)}
          >
            <span className="stat-icon" style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}>
              <Icon name="job" size={16} />
            </span>
            <div className="row-main">
              <div className="row-title">{j.name}</div>
              <div className="row-sub">{`${j.location === 'agent' ? 'Agent' : 'Local'} · ${j.paths.join(', ')}`}</div>
            </div>
            <div className="row-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => onSelect(j)}>
                <Icon name="snapshot" />
                Snapshots
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SnapshotsPanel({
  job,
  onBack,
  reloadHistory,
}: {
  job: Job;
  onBack: () => void;
  reloadHistory: () => void;
}) {
  const { data: snaps, loading, error, reload } = useAsync<Snapshot[]>(
    () => api.get<Snapshot[]>(`/jobs/${job.id}/snapshots`),
    [job.id],
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="loading">
        <Spinner />
        Loading snapshots…
      </div>
    );
  } else if (error) {
    body = <div className="empty">{error.message}</div>;
  } else if (!snaps || snaps.length === 0) {
    body = <div className="empty">No snapshots in this repository.</div>;
  } else {
    body = snaps.map((s) => (
      <SnapshotRow key={s.id} jobId={job.id} snap={s} reload={reload} reloadHistory={reloadHistory} />
    ));
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <Icon name="arrow-left" />
            Back
          </button>
          <h2>{`${job.name} — Snapshots${snaps ? ` (${snaps.length})` : ''}`}</h2>
        </div>
      </div>
      {body}
    </div>
  );
}

function SnapshotRow({
  jobId,
  snap: s,
  reload,
  reloadHistory,
}: {
  jobId: string;
  snap: Snapshot;
  reload: () => void;
  reloadHistory: () => void;
}) {
  const { open } = useModal();

  const openRestore = (includedPaths: string[]) =>
    open((close) => (
      <RestoreDialog
        jobId={jobId}
        snap={s}
        includedPaths={includedPaths}
        onClose={close}
        reloadHistory={reloadHistory}
      />
    ));

  const openBrowse = () =>
    open((close) => (
      <BrowserModal jobId={jobId} snap={s} onClose={close} openRestore={openRestore} />
    ));

  const openDelete = () =>
    open((close) => <DeleteSnapshotDialog jobId={jobId} snap={s} onClose={close} reload={reload} />);

  return (
    <div className="row">
      <span className="stat-icon" style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}>
        <Icon name="snapshot" size={16} />
      </span>
      <div className="row-main">
        <div className="row-title">{`${s.hostname} · ${s.paths.join(', ')}`}</div>
        <div className="row-sub">{`${s.short_id ?? s.id.slice(0, 8)} · ${fmtDateTime(s.time)}`}</div>
      </div>
      {s.tags && s.tags.length ? (
        <div className="tags">
          {s.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      ) : null}
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" title="Browse" onClick={openBrowse}>
          <Icon name="folder" />
          Browse
        </button>
        <button className="btn btn-primary btn-sm" title="Restore" onClick={() => openRestore([])}>
          <Icon name="restore" />
          Restore
        </button>
        <button className="btn btn-ghost btn-sm" title="Delete snapshot" onClick={openDelete}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

function DeleteSnapshotDialog({
  jobId,
  snap: s,
  onClose,
  reload,
}: {
  jobId: string;
  snap: Snapshot;
  onClose: () => void;
  reload: () => void;
}) {
  const toast = useToast();
  const [prune, setPrune] = useState(false);
  const shortId = s.short_id ?? s.id.slice(0, 8);

  const submit = async () => {
    try {
      await api.del(`/jobs/${jobId}/snapshots/${s.id}?prune=${prune}`);
      toast(prune ? 'Snapshot deleted and pruned' : 'Snapshot deleted', 'success');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
      return false;
    }
  };

  return (
    <FormModal title="Delete snapshot" confirmLabel="Delete" onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="warn-box">{`Snapshot ${shortId} (${fmtDateTime(s.time)}) will be permanently removed. This cannot be undone.`}</div>
        <label className="checkbox">
          <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
          Also prune now — reclaim storage immediately (slower, locks the repository)
        </label>
      </div>
    </FormModal>
  );
}

function BrowserModal({
  jobId,
  snap,
  onClose,
  openRestore,
}: {
  jobId: string;
  snap: Snapshot;
  onClose: () => void;
  openRestore: (paths: string[]) => void;
}) {
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: entries, loading, error } = useAsync<LsEntry[]>(
    () =>
      api.get<LsEntry[]>(
        `/jobs/${jobId}/snapshots/${snap.id}/ls${path ? `?path=${encodeURIComponent(path)}` : ''}`,
      ),
    [path],
  );

  const toggle = (p: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const parts = path.split('/').filter(Boolean);
  const crumbs: React.ReactNode[] = [
    <span className="crumb" key="root" onClick={() => setPath('')}>
      /
    </span>,
  ];
  let acc = '';
  parts.forEach((p, i) => {
    acc += '/' + p;
    const target = acc;
    crumbs.push(
      <span key={`sep${i}`}>/</span>,
      <span className="crumb" key={`crumb${i}`} onClick={() => setPath(target)}>
        {p}
      </span>,
    );
  });

  let list: React.ReactNode;
  if (loading) {
    list = (
      <div className="loading">
        <Spinner />
      </div>
    );
  } else if (error) {
    list = <div className="empty">{error.message}</div>;
  } else if (!entries || entries.length === 0) {
    list = <div className="empty">Empty directory.</div>;
  } else {
    list = entries.map((e) => {
      const isDir = e.type === 'dir';
      return (
        <div className="fb-item" key={e.path} onClick={() => isDir && setPath(e.path)}>
          <input
            type="checkbox"
            checked={selected.has(e.path)}
            onClick={(ev) => ev.stopPropagation()}
            onChange={() => toggle(e.path)}
          />
          {/* display:flex so the svg (Icon renders display:contents) is
              centered by the flex row instead of sitting on the baseline */}
          <span style={{ display: 'flex', color: `var(--${isDir ? 'amber' : 'text-3'})` }}>
            <Icon name={isDir ? 'folder' : 'file'} />
          </span>
          <span className="fb-name">{e.name}</span>
          <span className="fb-size">{isDir ? '' : fmtBytes(e.size)}</span>
        </div>
      );
    });
  }

  return (
    <FormModal
      title={`Browse snapshot ${snap.short_id ?? snap.id.slice(0, 8)}`}
      wide
      confirmLabel="Restore selected"
      onClose={onClose}
      onSubmit={() => {
        openRestore([...selected]);
        return true;
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="fb">
          <div className="fb-crumbs">{crumbs}</div>
          <div>{list}</div>
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>{`${selected.size} selected`}</span>
      </div>
    </FormModal>
  );
}

function RestoreDialog({
  jobId,
  snap,
  includedPaths,
  onClose,
  reloadHistory,
}: {
  jobId: string;
  snap: Snapshot;
  includedPaths: string[];
  onClose: () => void;
  reloadHistory: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState('download');
  const [targetPath, setTargetPath] = useState('');
  const [overwrite, setOverwrite] = useState('always');
  const [verify, setVerify] = useState(false);
  const [del, setDel] = useState(false);

  const buildPayload = (dryRun: boolean) => ({
    jobId,
    snapshotId: snap.id,
    includedPaths: includedPaths.length ? includedPaths : undefined,
    mode,
    destination: mode === 'download' ? {} : { path: targetPath },
    options: {
      overwrite,
      verify,
      delete: del,
      dryRun,
    },
  });

  const dryRun = async () => {
    try {
      await api.post('/restores', buildPayload(true));
      toast('Dry run started — see the history', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  const submit = async () => {
    try {
      await api.post('/restores', buildPayload(false));
      toast('Restore started', 'success');
      reloadHistory();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={`Restore${includedPaths.length ? ` (${includedPaths.length} paths)` : ''}`}
      confirmLabel="Restore"
      onClose={onClose}
      onSubmit={submit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Mode">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="download">Download (archive)</option>
            <option value="alternate_path">Alternate path (server)</option>
            <option value="original">Original location</option>
          </select>
        </Field>
        {mode !== 'download' && (
          <Field label="Target path">
            <input
              type="text"
              placeholder="/tmp/restore-target"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
            />
          </Field>
        )}
        <Field label="Overwrite">
          <select value={overwrite} onChange={(e) => setOverwrite(e.target.value)}>
            <option value="always">always (overwrite everything)</option>
            <option value="if-changed">if-changed</option>
            <option value="if-newer">if-newer</option>
            <option value="never">never</option>
          </select>
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
          Verify (--verify)
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} />
          Delete foreign files (--delete)
        </label>
        {del && (
          <div className="warn-box">
            ⚠ Warning: --delete removes files in the target that are not in the snapshot.
          </div>
        )}
        <div>
          <button className="btn btn-ghost" onClick={dryRun}>
            Dry run
          </button>
        </div>
      </div>
    </FormModal>
  );
}

function HistoryPanel({ runs }: { runs: RestoreRun[] | undefined }) {
  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>Restore history</h2>
      </div>
      {!runs ? (
        <Loading />
      ) : runs.length === 0 ? (
        <div className="empty">No restores yet.</div>
      ) : (
        runs.map((r) => <HistoryRow key={r.id} run={r} />)
      )}
    </div>
  );
}

function HistoryRow({ run: r }: { run: RestoreRun }) {
  const modeLabels: Record<string, string> = {
    original: 'Original',
    alternate_path: 'Alt. path',
    download: 'Download',
  };
  const canDownload =
    r.mode === 'download' &&
    r.status === 'success' &&
    (!r.download_expires_at || new Date(r.download_expires_at) > new Date());

  return (
    <div className="row">
      <span className={`status-dot ${r.status}`} />
      <div className="row-main">
        <div className="row-title">{`${modeLabels[r.mode] ?? r.mode} · ${r.snapshot_id.slice(0, 12)}`}</div>
        <div className="row-sub">{`${statusLabel(r.status)} · ${fmtRelative(r.finished_at ?? r.created_at)}${r.error ? ' · ' + r.error : ''}`}</div>
      </div>
      {canDownload && (
        <div className="row-actions">
          <a className="btn btn-ghost btn-sm" href={`/api/restores/${r.id}/download`}>
            <Icon name="download" />
            Download
          </a>
        </div>
      )}
    </div>
  );
}
