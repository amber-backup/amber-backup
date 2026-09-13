import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Job, type Snapshot, type LsEntry, type RestoreRun } from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtRelative, statusLabel } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, Field, Loading, Spinner } from '../ui/primitives';
import { IntegrityBadge, IntegrityPanel } from '../ui/integrity';
import { useT } from '../i18n';
import type { SnapshotsMessages } from '../i18n/en/snapshots';

/**
 * Snapshots of each job's repository: browse, restore, delete — and verify the
 * repository's integrity. The selected job lives in the URL (`#/snapshots/:jobId`,
 * id or slug) so it can be linked to.
 */
export function Snapshots() {
  const t = useT();
  const navigate = useNavigate();
  const { jobId } = useParams();
  const { data: jobs, loading, reload } = useAsync(() => api.get<Job[]>('/jobs'));
  const history = useAsync(() => api.get<RestoreRun[]>('/restores?limit=15').catch(() => [] as RestoreRun[]));

  // Keep showing the list while a reload (after a check) is in flight.
  if (!jobs) return <Loading label={t.common.loading} />;
  const job = jobId ? jobs.find((j) => j.id === jobId || j.slug === jobId) : undefined;

  return (
    <div>
      {jobId && (
        <button className="btn btn-ghost btn-sm page-back" onClick={() => navigate('/snapshots')}>
          <Icon name="arrow-left" />
          {t.snapshots.page.back}
        </button>
      )}
      <PageHeader
        title={t.snapshots.page.title}
        subtitle={job ? t.snapshots.page.subtitleJob : t.snapshots.page.subtitleList}
      />
      {job ? (
        <>
          <IntegrityPanel job={job} onChanged={reload} />
          <div className="section-gap">
            <SnapshotsPanel job={job} reloadHistory={history.reload} />
          </div>
          <HistoryPanel runs={history.data} />
        </>
      ) : jobId && !loading ? (
        <div className="panel">
          <div className="empty">{t.snapshots.page.jobNotFound}</div>
        </div>
      ) : (
        <JobListPanel jobs={jobs} onSelect={(j) => navigate(`/snapshots/${j.slug}`)} />
      )}
    </div>
  );
}

function JobListPanel({ jobs, onSelect }: { jobs: Job[]; onSelect: (j: Job) => void }) {
  const t = useT().snapshots.jobList;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.title(jobs.length)}</h2>
      </div>
      {jobs.length === 0 ? (
        <div className="empty">{t.empty}</div>
      ) : (
        jobs.map((j) => (
          // The whole row opens the job; the chevron only hints at that. Without
          // a button inside, the row itself takes keyboard focus.
          <div
            className="row compact row-link"
            key={j.id}
            role="link"
            tabIndex={0}
            title={`${j.location === 'agent' ? t.agent : t.local} · ${j.paths.join(', ')}`}
            onClick={() => onSelect(j)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(j);
              }
            }}
          >
            <div className="row-main">
              <div className="row-title">{j.name}</div>
              <div className="row-sub">{repoSizeLabel(j, t)}</div>
            </div>
            <IntegrityBadge job={j} />
            <span className="row-chevron" aria-hidden="true">
              <Icon name="chevron-right" />
            </span>
          </div>
        ))
      )}
    </div>
  );
}

/** Cached repository size and snapshot count, as read after the last successful run. */
function repoSizeLabel(j: Job, t: SnapshotsMessages['jobList']): string {
  if (j.repo_size_bytes == null) return t.sizeUnknown;
  return t.sizeSummary(fmtBytes(j.repo_size_bytes), j.repo_snapshot_count ?? '?');
}

function SnapshotsPanel({ job, reloadHistory }: { job: Job; reloadHistory: () => void }) {
  const t = useT().snapshots.list;
  const { data: snaps, loading, error, reload } = useAsync<Snapshot[]>(
    () => api.get<Snapshot[]>(`/jobs/${job.id}/snapshots`),
    [job.id],
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="loading">
        <Spinner />
        {t.loading}
      </div>
    );
  } else if (error) {
    body = <div className="empty">{error.message}</div>;
  } else if (!snaps || snaps.length === 0) {
    body = <div className="empty">{t.empty}</div>;
  } else {
    body = snaps.map((s) => (
      <SnapshotRow key={s.id} jobId={job.id} snap={s} reload={reload} reloadHistory={reloadHistory} />
    ));
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.title(job.name, snaps?.length)}</h2>
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
  const t = useT().snapshots.list;
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
    <div className="row compact" title={s.paths.join(', ')}>
      <div className="row-main">
        <div className="row-title">{fmtDateTime(s.time)}</div>
        <div className="row-sub">{`${s.short_id ?? s.id.slice(0, 8)} · ${s.hostname}`}</div>
      </div>
      {s.tags && s.tags.length ? (
        <div className="tags">
          {s.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" title={t.browse} onClick={openBrowse}>
          <Icon name="folder" />
          {t.browse}
        </button>
        <button className="btn btn-primary btn-sm" title={t.restore} onClick={() => openRestore([])}>
          <Icon name="restore" />
          {t.restore}
        </button>
        <button className="btn btn-ghost btn-sm" title={t.deleteSnapshot} onClick={openDelete}>
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
  const { snapshots, common } = useT();
  const t = snapshots.deleteDialog;
  const toast = useToast();
  const [prune, setPrune] = useState(false);
  const shortId = s.short_id ?? s.id.slice(0, 8);

  const submit = async () => {
    try {
      await api.del(`/jobs/${jobId}/snapshots/${s.id}?prune=${prune}`);
      toast(prune ? t.deletedPruning : t.deleted, 'success');
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : t.failed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.title} confirmLabel={common.delete} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="warn-box">{t.warning(shortId, fmtDateTime(s.time))}</div>
        <label className="checkbox">
          <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
          {t.prune}
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
  const t = useT().snapshots.browser;
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
    list = <div className="empty">{t.emptyDir}</div>;
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
      title={t.title(snap.short_id ?? snap.id.slice(0, 8))}
      wide
      confirmLabel={t.restoreSelected}
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
        <span className="muted" style={{ fontSize: 12.5 }}>{t.selected(selected.size)}</span>
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
  const { snapshots, common } = useT();
  const t = snapshots.restore;
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
      toast(t.dryRunStarted, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : common.error, 'error');
    }
  };

  const submit = async () => {
    try {
      await api.post('/restores', buildPayload(false));
      toast(t.started, 'success');
      reloadHistory();
    } catch (err) {
      toast(err instanceof Error ? err.message : common.error, 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={t.title(includedPaths.length)}
      confirmLabel={t.confirm}
      onClose={onClose}
      onSubmit={submit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={t.mode}>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="download">{t.modeDownload}</option>
            <option value="alternate_path">{t.modeAlternate}</option>
            <option value="original">{t.modeOriginal}</option>
          </select>
        </Field>
        {mode !== 'download' && (
          <Field label={t.targetPath}>
            <input
              type="text"
              placeholder="/tmp/restore-target"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
            />
          </Field>
        )}
        <Field label={t.overwrite}>
          <select value={overwrite} onChange={(e) => setOverwrite(e.target.value)}>
            <option value="always">{t.overwriteAlways}</option>
            <option value="if-changed">if-changed</option>
            <option value="if-newer">if-newer</option>
            <option value="never">never</option>
          </select>
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
          {t.verify}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} />
          {t.deleteForeign}
        </label>
        {del && (
          <div className="warn-box">{t.deleteWarning}</div>
        )}
        <div>
          <button className="btn btn-ghost" onClick={dryRun}>
            {t.dryRun}
          </button>
        </div>
      </div>
    </FormModal>
  );
}

function HistoryPanel({ runs }: { runs: RestoreRun[] | undefined }) {
  const t = useT().snapshots.history;
  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>{t.title}</h2>
      </div>
      {!runs ? (
        <Loading />
      ) : runs.length === 0 ? (
        <div className="empty">{t.empty}</div>
      ) : (
        runs.map((r) => <HistoryRow key={r.id} run={r} />)
      )}
    </div>
  );
}

function HistoryRow({ run: r }: { run: RestoreRun }) {
  const t = useT().snapshots.history;
  const modeLabels: Record<string, string> = {
    original: t.modeOriginal,
    alternate_path: t.modeAlternate,
    download: t.modeDownload,
  };
  const canDownload =
    r.mode === 'download' &&
    r.status === 'success' &&
    (!r.download_expires_at || new Date(r.download_expires_at) > new Date());

  return (
    <div className="row compact">
      <span className={`status-dot ${r.status}`} />
      <div className="row-main">
        <div className="row-title">{`${modeLabels[r.mode] ?? r.mode} · ${r.snapshot_id.slice(0, 12)}`}</div>
        <div className="row-sub">{`${statusLabel(r.status)} · ${fmtRelative(r.finished_at ?? r.created_at)}${r.error ? ' · ' + r.error : ''}`}</div>
      </div>
      {canDownload && (
        <div className="row-actions">
          <a className="btn btn-ghost btn-sm" href={`/api/restores/${r.id}/download`}>
            <Icon name="download" />
            {t.download}
          </a>
        </div>
      )}
    </div>
  );
}
