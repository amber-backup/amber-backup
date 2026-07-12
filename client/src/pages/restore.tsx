import { useState } from 'react';
import { api, type Target, type Snapshot, type LsEntry, type RestoreRun } from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtRelative, statusLabel } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, Field, Loading, Spinner } from '../ui/primitives';

export function Restore() {
  const { data: targets, loading } = useAsync(() => api.get<Target[]>('/targets'));
  const [targetId, setTargetId] = useState('');
  const history = useAsync(() => api.get<RestoreRun[]>('/restores?limit=15').catch(() => [] as RestoreRun[]));

  if (loading || !targets) return <Loading label="Loading…" />;

  return (
    <div>
      <PageHeader
        title="Restore"
        subtitle="Browse snapshots and restore selectively or in full"
        actions={
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <select style={{ maxWidth: 280 }} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">— Select target —</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        }
      />
      <SnapshotsPanel targetId={targetId} reloadHistory={history.reload} />
      <HistoryPanel runs={history.data} />
    </div>
  );
}

function SnapshotsPanel({ targetId, reloadHistory }: { targetId: string; reloadHistory: () => void }) {
  const { data: snaps, loading, error, reload } = useAsync<Snapshot[] | null>(
    () => (targetId ? api.get<Snapshot[]>(`/targets/${targetId}/snapshots`) : Promise.resolve(null)),
    [targetId],
  );

  if (!targetId) {
    return (
      <div className="panel">
        <div className="empty">Select a target to browse snapshots.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="panel">
        <div className="loading">
          <Spinner />
          Loading snapshots…
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="panel">
        <div className="empty">{error.message}</div>
      </div>
    );
  }
  if (!snaps) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{`Snapshots (${snaps.length})`}</h2>
      </div>
      {snaps.length === 0 ? (
        <div className="empty">No snapshots in this repository.</div>
      ) : (
        snaps.map((s) => (
          <SnapshotRow key={s.id} targetId={targetId} snap={s} reload={reload} reloadHistory={reloadHistory} />
        ))
      )}
    </div>
  );
}

function SnapshotRow({
  targetId,
  snap: s,
  reload,
  reloadHistory,
}: {
  targetId: string;
  snap: Snapshot;
  reload: () => void;
  reloadHistory: () => void;
}) {
  const { open } = useModal();

  const openRestore = (includedPaths: string[]) =>
    open((close) => (
      <RestoreDialog
        targetId={targetId}
        snap={s}
        includedPaths={includedPaths}
        onClose={close}
        reloadHistory={reloadHistory}
      />
    ));

  const openBrowse = () =>
    open((close) => (
      <BrowserModal targetId={targetId} snap={s} onClose={close} openRestore={openRestore} />
    ));

  const openDelete = () =>
    open((close) => <DeleteSnapshotDialog targetId={targetId} snap={s} onClose={close} reload={reload} />);

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
  );
}

function DeleteSnapshotDialog({
  targetId,
  snap: s,
  onClose,
  reload,
}: {
  targetId: string;
  snap: Snapshot;
  onClose: () => void;
  reload: () => void;
}) {
  const toast = useToast();
  const [prune, setPrune] = useState(false);
  const shortId = s.short_id ?? s.id.slice(0, 8);

  const submit = async () => {
    try {
      await api.del(`/targets/${targetId}/snapshots/${s.id}?prune=${prune}`);
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
  targetId,
  snap,
  onClose,
  openRestore,
}: {
  targetId: string;
  snap: Snapshot;
  onClose: () => void;
  openRestore: (paths: string[]) => void;
}) {
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: entries, loading, error } = useAsync<LsEntry[]>(
    () =>
      api.get<LsEntry[]>(
        `/targets/${targetId}/snapshots/${snap.id}/ls${path ? `?path=${encodeURIComponent(path)}` : ''}`,
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
          <span style={{ color: `var(--${isDir ? 'amber' : 'text-3'})` }}>
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
  targetId,
  snap,
  includedPaths,
  onClose,
  reloadHistory,
}: {
  targetId: string;
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
    targetId,
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
        <a className="btn btn-ghost btn-sm" href={`/api/restores/${r.id}/download`}>
          <Icon name="download" />
          Download
        </a>
      )}
    </div>
  );
}
