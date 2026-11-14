import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Agent, type Job, type Snapshot, type LsEntry, type RestoreRun } from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtRelative, restoreModeLabel, statusLabel } from '../core/format';
import { matchesSearch } from '../core/search';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal, ModalFrame } from '../ui/modal';
import { RunDetailModal } from '../ui/run-detail';
import { PageHeader, Field, Loading, Spinner, ListSearch } from '../ui/primitives';
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
          <HistoryPanel runs={history.data} jobs={jobs} />
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
  const noMatches = useT().common.noMatches;
  const [query, setQuery] = useState('');
  const shown = jobs.filter((j) => matchesSearch(query, [j.name, ...j.paths]));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.title(jobs.length)}</h2>
        <ListSearch value={query} onChange={setQuery} />
      </div>
      {jobs.length === 0 ? (
        <div className="empty">{t.empty}</div>
      ) : shown.length === 0 ? (
        <div className="empty">{noMatches}</div>
      ) : (
        shown.map((j) => (
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
  const noMatches = useT().common.noMatches;
  const [query, setQuery] = useState('');
  const { data: snaps, loading, error, reload } = useAsync<Snapshot[]>(
    () => api.get<Snapshot[]>(`/jobs/${job.id}/snapshots`),
    [job.id],
  );
  const shown = (snaps ?? []).filter((s) =>
    matchesSearch(query, [fmtDateTime(s.time), s.id, s.hostname, ...(s.tags ?? []), ...s.paths]),
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
  } else if (shown.length === 0) {
    body = <div className="empty">{noMatches}</div>;
  } else {
    body = shown.map((s) => (
      <SnapshotRow key={s.id} job={job} snap={s} reload={reload} reloadHistory={reloadHistory} />
    ));
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.title(job.name, snaps?.length)}</h2>
        <ListSearch value={query} onChange={setQuery} />
      </div>
      {body}
    </div>
  );
}

function SnapshotRow({
  job,
  snap: s,
  reload,
  reloadHistory,
}: {
  job: Job;
  snap: Snapshot;
  reload: () => void;
  reloadHistory: () => void;
}) {
  const t = useT().snapshots.list;
  const { open } = useModal();
  const jobId = job.id;

  const openRestore = (includedPaths: string[]) =>
    open((close) => (
      <RestoreDialog
        job={job}
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
    <FormModal title={t.title} confirmLabel={common.delete} danger onClose={onClose} onSubmit={submit}>
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
    <button type="button" className="crumb" key="root" aria-label={t.root} onClick={() => setPath('')}>
      /
    </button>,
  ];
  let acc = '';
  parts.forEach((p, i) => {
    acc += '/' + p;
    const target = acc;
    crumbs.push(
      <span key={`sep${i}`} aria-hidden="true">/</span>,
      <button
        type="button"
        className="crumb"
        key={`crumb${i}`}
        aria-current={i === parts.length - 1 ? 'location' : undefined}
        onClick={() => setPath(target)}
      >
        {p}
      </button>,
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
            aria-label={t.selectItem(e.name)}
            onClick={(ev) => ev.stopPropagation()}
            onChange={() => toggle(e.path)}
          />
          {/* display:flex so the svg (Icon renders display:contents) is
              centered by the flex row instead of sitting on the baseline */}
          <span style={{ display: 'flex', color: `var(--${isDir ? 'amber' : 'text-3'})` }}>
            <Icon name={isDir ? 'folder' : 'file'} />
          </span>
          {isDir ? (
            // A real button so folders open from the keyboard too; the row
            // click stays as the larger mouse target.
            <button
              type="button"
              className="fb-name fb-open"
              aria-label={t.openFolder(e.name)}
              onClick={(ev) => {
                ev.stopPropagation();
                setPath(e.path);
              }}
            >
              {e.name}
            </button>
          ) : (
            <span className="fb-name">{e.name}</span>
          )}
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

type RestoreMode = 'download' | 'alternate_path' | 'original';
type Overwrite = 'if-changed' | 'if-newer' | 'never' | 'always';

/**
 * Restores a snapshot (or a selection of it). File restores run where the job
 * runs — on its agent's host, or on the server — and the dialog names that
 * host. Writing to the original location never asks for a path, defaults to
 * replacing only changed files and cannot delete foreign files; before any
 * filesystem restore starts, a summary repeats where it writes and how, with a
 * dry run as the recommended first step.
 */
function RestoreDialog({
  job,
  snap,
  includedPaths,
  onClose,
  reloadHistory,
}: {
  job: Job;
  snap: Snapshot;
  includedPaths: string[];
  onClose: () => void;
  reloadHistory: () => void;
}) {
  const { snapshots, common } = useT();
  const t = snapshots.restore;
  const s = t.summary;
  const toast = useToast();
  const [mode, setMode] = useState<RestoreMode>('download');
  const [targetPath, setTargetPath] = useState('');
  const [overwrite, setOverwrite] = useState<Overwrite>('if-changed');
  const [verify, setVerify] = useState(false);
  const [del, setDel] = useState(false);
  const [step, setStep] = useState<'form' | 'summary'>('form');
  const [busy, setBusy] = useState(false);
  // The summary replaces the form (and the button that opened it): move the
  // focus to its recommended action, the dry run.
  const dryRunRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (step === 'summary') dryRunRef.current?.focus();
  }, [step]);

  // Where a file restore runs: the job's agent, or the server itself.
  const onAgent = job.location === 'agent' && !!job.agent_id;
  const { data: agents } = useAsync(
    () => (onAgent ? api.get<Agent[]>('/agents').catch(() => [] as Agent[]) : Promise.resolve([] as Agent[])),
    [onAgent],
  );
  const agent = agents?.find((a) => a.id === job.agent_id);
  const host = !onAgent
    ? t.serverHost
    : agent
      ? agent.hostname && agent.hostname !== agent.name
        ? `${agent.name} (${agent.hostname})`
        : agent.name
      : t.agentFallback;
  const paths = includedPaths.length ? includedPaths : snap.paths;
  // A Hyper-V or Proxmox snapshot holds VM disks and guest images; writing
  // them back to their "original" paths would overwrite the live disks on the
  // host. Those jobs restore VMs through their own dialogs, so here they only
  // offer the download and a separate folder.
  const originalAllowed = !job.source_kind || job.source_kind === 'files';
  // --delete only makes sense for a folder the restore owns.
  const deleteAllowed = mode === 'alternate_path';
  const deleting = deleteAllowed && del;
  const shortId = snap.short_id ?? snap.id.slice(0, 8);

  const changeMode = (next: RestoreMode) => {
    setMode(next);
    if (next !== 'alternate_path') setDel(false);
    setStep('form');
  };

  const buildPayload = (dryRun: boolean) => {
    const destination: Record<string, string> = {};
    if (mode !== 'download') {
      // The restore runs on the job's agent; without the id the server would
      // write to its own filesystem.
      if (onAgent && job.agent_id) destination.agentId = job.agent_id;
      if (mode === 'alternate_path') destination.path = targetPath.trim();
    }
    return {
      jobId: job.id,
      snapshotId: snap.id,
      includedPaths: includedPaths.length ? includedPaths : undefined,
      mode,
      destination,
      options: { overwrite, verify, delete: deleting, dryRun },
    };
  };

  const start = async (dryRun: boolean) => {
    setBusy(true);
    try {
      await api.post('/restores', buildPayload(dryRun));
      toast(dryRun ? t.dryRunStarted : t.started, 'success');
      reloadHistory();
      // A dry run keeps the dialog open so the real restore can follow.
      if (!dryRun) onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : common.error, 'error');
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (mode === 'download') {
      void start(false);
      return;
    }
    if (mode === 'alternate_path' && !targetPath.trim()) {
      toast(t.targetPathRequired, 'error');
      return;
    }
    setStep('summary');
  };

  const overwriteLabel: Record<Overwrite, string> = {
    'if-changed': t.overwriteIfChanged,
    'if-newer': t.overwriteIfNewer,
    never: t.overwriteNever,
    always: t.overwriteAlways,
  };
  const risky = mode === 'original' || deleting || overwrite === 'always';

  const footer =
    step === 'form' ? (
      <>
        <button className="btn btn-ghost" onClick={onClose}>
          {common.cancel}
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={next}>
          {mode === 'download' ? t.confirm : t.continue}
        </button>
      </>
    ) : (
      <>
        <button className="btn btn-ghost" disabled={busy} onClick={() => setStep('form')}>
          <Icon name="arrow-left" size={14} />
          {t.back}
        </button>
        <button
          className={`btn ${risky ? 'btn-danger-solid' : 'btn-primary'}`}
          disabled={busy}
          onClick={() => void start(false)}
        >
          <Icon name="restore" size={14} />
          {t.start}
        </button>
      </>
    );

  return (
    <ModalFrame
      title={step === 'summary' ? t.summaryTitle : t.title(includedPaths.length)}
      onClose={onClose}
      footer={footer}
    >
      {step === 'form' ? (
        <div className="dialog-stack">
          <Field label={t.mode}>
            <select value={mode} onChange={(e) => changeMode(e.target.value as RestoreMode)}>
              <option value="download">{t.modeDownload}</option>
              <option value="alternate_path">{t.modeAlternate(host)}</option>
              {originalAllowed && <option value="original">{t.modeOriginal(host)}</option>}
            </select>
          </Field>
          {mode === 'download' && <div className="run-detail-note">{t.downloadInfo}</div>}
          {mode === 'alternate_path' && (
            <Field label={t.targetPath(host)} help={t.targetPathHelp}>
              <input
                type="text"
                placeholder="/srv/restore"
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
              />
            </Field>
          )}
          {mode === 'original' && (
            <div className="info-box">
              {t.originalInfo(host)}
              <ul className="path-list">
                {paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {mode !== 'download' && (
            <>
              <Field label={t.overwrite}>
                <select value={overwrite} onChange={(e) => setOverwrite(e.target.value as Overwrite)}>
                  <option value="if-changed">{t.overwriteIfChanged}</option>
                  <option value="if-newer">{t.overwriteIfNewer}</option>
                  <option value="never">{t.overwriteNever}</option>
                  <option value="always">{t.overwriteAlways}</option>
                </select>
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
                {t.verify}
              </label>
              {deleteAllowed && (
                <label className="checkbox">
                  <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} />
                  {t.deleteForeign}
                </label>
              )}
              {deleting && <div className="warn-box">{t.deleteWarning}</div>}
            </>
          )}
        </div>
      ) : (
        <div className="dialog-stack">
          <dl className="summary-list">
            <dt>{s.host}</dt>
            <dd>{host}</dd>
            <dt>{s.writesTo}</dt>
            <dd>
              {mode === 'original' ? (
                <>
                  {s.originalPaths}
                  <ul className="path-list">
                    {paths.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <span className="mono">{targetPath.trim()}</span>
              )}
            </dd>
            <dt>{s.snapshot}</dt>
            <dd>{`${shortId} · ${fmtDateTime(snap.time)} · ${snap.hostname}`}</dd>
            <dt>{s.selection}</dt>
            <dd>{includedPaths.length ? s.selectionPaths(includedPaths.length) : s.selectionAll}</dd>
            <dt>{s.existing}</dt>
            <dd>{overwriteLabel[overwrite]}</dd>
            <dt>{s.foreign}</dt>
            <dd className={deleting ? 'danger-text' : undefined}>{deleting ? s.foreignDelete : s.foreignKeep}</dd>
            <dt>{s.verify}</dt>
            <dd>{verify ? s.yes : s.no}</dd>
          </dl>
          {mode === 'original' && <div className="warn-box">{t.originalWarning(host)}</div>}
          {deleting && <div className="warn-box">{t.deleteWarning}</div>}
          <div className="dry-run-box">
            <span>{t.dryRunHint}</span>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              ref={dryRunRef}
              onClick={() => void start(true)}
            >
              {t.dryRun}
            </button>
          </div>
        </div>
      )}
    </ModalFrame>
  );
}

function HistoryPanel({ runs, jobs }: { runs: RestoreRun[] | undefined; jobs: Job[] }) {
  const t = useT().snapshots.history;
  const noMatches = useT().common.noMatches;
  const [query, setQuery] = useState('');
  const shown = (runs ?? []).filter((r) =>
    matchesSearch(query, [restoreModeLabel(r.mode), r.snapshot_id, statusLabel(r.status), r.error]),
  );
  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>{t.title}</h2>
        <ListSearch value={query} onChange={setQuery} />
      </div>
      {!runs ? (
        <Loading />
      ) : runs.length === 0 ? (
        <div className="empty">{t.empty}</div>
      ) : shown.length === 0 ? (
        <div className="empty">{noMatches}</div>
      ) : (
        shown.map((r) => (
          <HistoryRow key={r.id} run={r} jobName={jobs.find((j) => j.id === r.job_id)?.name ?? null} />
        ))
      )}
    </div>
  );
}

function HistoryRow({ run: r, jobName }: { run: RestoreRun; jobName: string | null }) {
  const t = useT().snapshots.history;
  const { open } = useModal();
  const openDetail = () =>
    open((close) => (
      <RunDetailModal run={{ id: r.id, kind: 'restore', job_id: r.job_id, job_name: jobName }} onClose={close} />
    ));
  const canDownload =
    r.mode === 'download' &&
    r.status === 'success' &&
    (!r.download_expires_at || new Date(r.download_expires_at) > new Date());

  return (
    <div className="row compact">
      <span className={`status-dot ${r.status}`} />
      <div className="row-main">
        <div className="row-title">{`${restoreModeLabel(r.mode)} · ${r.snapshot_id.slice(0, 12)}`}</div>
        <div className="row-sub">{`${statusLabel(r.status)} · ${fmtRelative(r.finished_at ?? r.created_at)}${r.error ? ' · ' + r.error : ''}`}</div>
      </div>
      <div className="row-actions">
        <button className="btn btn-ghost btn-sm" onClick={openDetail}>
          <Icon name="file" size={14} />
          {t.details}
        </button>
        {canDownload && (
          <a className="btn btn-ghost btn-sm" href={`/api/restores/${r.id}/download`}>
            <Icon name="download" />
            {t.download}
          </a>
        )}
      </div>
    </div>
  );
}
