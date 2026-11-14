import { useEffect, useState } from 'react';
import { proxmoxApi, type ProxmoxGuestResult, type ProxmoxRunItem } from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtRelative, statusLabel } from '../core/format';
import { Loading, Empty } from './primitives';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';

// Per-guest rows of a Proxmox backup run. Shared by the Proxmox pages, the
// overview and the run detail dialog.

const REFRESH_MS = 5000;

/** Label of a backup method. */
export function methodLabel(t: Messages, method: string | null | undefined): string {
  if (!method) return '';
  return (t.proxmox.method as Record<string, string>)[method] ?? method;
}

/** "incremental · application-consistent" etc. for one guest result. */
export function resultDetails(t: Messages, r: ProxmoxGuestResult): string[] {
  const out: string[] = [];
  if (r.method) out.push(methodLabel(t, r.method));
  if (r.cbt) out.push(t.proxmox.cbt[r.cbt]);
  if (r.consistency) out.push(t.proxmox.consistency[r.consistency]);
  return out;
}

/** The per-guest rows of a Proxmox backup run, polled while the run is active. */
export function ProxmoxRunItemsList({ runId, active }: { runId: string; active: boolean }) {
  const m = useT().proxmox.runItems;
  const [items, setItems] = useState<ProxmoxRunItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      proxmoxApi
        .runItems(runId)
        .then((r) => live && setItems(r))
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    void load();
    if (!active) return () => {
      live = false;
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [runId, active]);

  if (error) return <Empty>{error}</Empty>;
  if (!items) return <Loading label={m.loading} />;
  if (items.length === 0) return <Empty>{m.empty}</Empty>;
  return (
    <div>
      {items.map((it) => (
        <RunItemRow key={it.id} item={it} />
      ))}
    </div>
  );
}

function RunItemRow({ item: it }: { item: ProxmoxRunItem }) {
  const t = useT();
  const m = t.proxmox.runItems;
  const r = it.result;
  const p = it.progress ?? {};
  const bytesDone = p.bytesDone as number | undefined;
  const totalBytes = p.totalBytes as number | undefined;
  const frac =
    totalBytes && totalBytes > 0 && bytesDone != null ? bytesDone / totalBytes : ((p.percentDone as number) ?? 0);
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  const details = r ? resultDetails(t, r) : it.method ? [methodLabel(t, it.method)] : [];
  const error = it.error ?? r?.error ?? null;

  return (
    <div className="row compact">
      <span className={`status-dot ${it.status}`} />
      <div className="row-main">
        <div className="row-title">
          <span className="badge muted" style={{ marginRight: 6 }}>
            {it.guestType === 'qemu' ? t.proxmox.detail.typeVm : t.proxmox.detail.typeCt}
          </span>
          {it.vmid} · {it.name}{' '}
          <span className="muted" style={{ fontSize: 12 }}>{it.node}</span>
        </div>
        <div className="row-sub" title={r?.cbtReason ?? error ?? ''}>
          {[
            ...details,
            r?.movedTo ? m.moved(r.movedTo) : null,
            r?.cbtReason && r.cbt === 'full' ? r.cbtReason : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          {error && (
            <div style={{ color: 'var(--red, #e5534b)' }}>{error.length > 300 ? `${error.slice(0, 300)}…` : error}</div>
          )}
          {r?.warnings && r.warnings.length > 0 && (
            <div className="warn-text">
              <Icon name="alert" size={12} />
              {m.warnings}: {r.warnings.join(' · ')}
            </div>
          )}
        </div>
      </div>
      {it.status === 'running' ? (
        <div className="row-meta run-progress">
          <div className="progress-track">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="run-progress-labels">
            <span>{totalBytes != null ? `${fmtBytes(bytesDone ?? 0)} / ${fmtBytes(totalBytes)}` : ''}</span>
            <span>{pct}%</span>
          </div>
        </div>
      ) : (
        <div className="row-meta run-meta pve-item-meta">
          <span>
            {it.status === 'queued' ? (
              <span className="badge info">{m.queued}</span>
            ) : it.status !== 'success' ? (
              <span className={`badge ${it.status === 'failed' ? 'danger' : 'muted'}`}>{statusLabel(it.status)}</span>
            ) : r ? (
              <span style={{ fontWeight: 500 }}>{m.read(fmtBytes(bytesRead(r)), fmtBytes(r.dataAdded ?? 0))}</span>
            ) : null}
          </span>
          <span className="muted">{it.finishedAt ? fmtRelative(it.finishedAt) : it.startedAt ? fmtRelative(it.startedAt) : ''}</span>
        </div>
      )}
    </div>
  );
}

/** Bytes a guest backup read; the agent omits a zero, e.g. an incremental run with nothing changed. */
function bytesRead(r: ProxmoxGuestResult): number | null {
  if (r.bytesRead != null) return r.bytesRead;
  return r.status === 'success' ? 0 : null;
}
