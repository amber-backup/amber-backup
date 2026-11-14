import { useEffect, useState, type ReactNode } from 'react';
import { api, type CheckInfo, type HypervVmRunResult, type Run } from '../core/api';
import { Icon } from '../core/icons';
import { copyToClipboard } from '../core/clipboard';
import {
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtRelative,
  restoreModeLabel,
  runDurationMs,
  statusLabel,
} from '../core/format';
import { useT } from '../i18n';
import { ModalFrame } from './modal';
import { BusyButton, Loading, Empty } from './primitives';
import { useToast } from './toast';
import { ProxmoxRunItemsList } from './proxmox-run-items';
import { checkLevelLabel } from './integrity';

/** How many log lines the dialog shows; the copy action takes the whole log. */
export const LOG_TAIL_LINES = 200;
/** Refresh interval while the run is still queued or running. */
const REFRESH_MS = 2000;

/** What the dialog needs to know up front: which row, and of what kind. */
export interface RunRef {
  id: string;
  kind: Run['kind'];
  job_id: string | null;
  job_name?: string | null;
}

/** A job run as `GET /runs/:id` returns it (the full row, with its log). */
type JobRunDetail = Run & { log?: string | null; check_info?: CheckInfo | null };

/** A restore as `GET /restores/:id` returns it. */
interface RestoreDetail {
  id: string;
  job_id: string | null;
  snapshot_id: string;
  mode: string;
  status: string;
  agent_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  stats: Record<string, unknown> | null;
  error: string | null;
  log: string | null;
  destination: { path?: string; agentId?: string } | null;
  options: { overwrite?: string; verify?: boolean; delete?: boolean; dryRun?: boolean } | null;
  included_paths: string[] | null;
}

type Detail = { kind: 'job'; run: JobRunDetail } | { kind: 'restore'; run: RestoreDetail };

const isActive = (status: string) => status === 'queued' || status === 'running';

/** JSON columns may arrive as text from some drivers; read them either way. */
function json<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

/** The last `n` lines of a log, and how many lines it has in total. */
export function logTail(log: string | null | undefined, n = LOG_TAIL_LINES): { lines: string[]; total: number } {
  const all = (log ?? '').replace(/\s+$/, '').split('\n');
  if (all.length === 1 && all[0] === '') return { lines: [], total: 0 };
  return { lines: all.slice(-n), total: all.length };
}

/**
 * Everything about one activity: status, timing, trigger and attempt, the
 * error, the tail of its log (copyable), Proxmox guests or Hyper-V VMs, and
 * the follow-up actions "Run again" and "Edit job". Refreshes itself while the
 * run is still active. Retries and retention prunes link to the run they
 * follow, which opens in the same dialog.
 */
export function RunDetailModal({
  run: initial,
  proxmox = false,
  agents = [],
  onClose,
  onEditJob,
  onStarted,
}: {
  run: RunRef;
  /** The run belongs to a Proxmox job: list its guests. */
  proxmox?: boolean;
  /** To name the agent a run went to. */
  agents?: { id: string; name: string }[];
  onClose: () => void;
  /** Opens the job editor; the action is hidden without it. */
  onEditJob?: (jobId: string) => void;
  /** Called after "Run again" started a new run. */
  onStarted?: () => void;
}) {
  const t = useT();
  const m = t.runs.detail;
  const toast = useToast();
  const [ref, setRef] = useState<RunRef>(initial);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = detail ? isActive(detail.run.status) : true;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;
    setDetail(null);
    setError(null);
    const load = async () => {
      try {
        const next: Detail =
          ref.kind === 'restore'
            ? { kind: 'restore', run: await api.get<RestoreDetail>(`/restores/${ref.id}`) }
            : { kind: 'job', run: await api.get<JobRunDetail>(`/runs/${ref.id}`) };
        if (!live) return;
        loaded = true;
        setDetail(next);
        setError(null);
        if (isActive(next.run.status)) timer = setTimeout(poll, REFRESH_MS);
      } catch (e) {
        if (!live) return;
        // A failed refresh keeps what is shown and tries again; only a failed
        // first load replaces the dialog's content with the error.
        if (loaded) timer = setTimeout(poll, REFRESH_MS);
        else setError(e instanceof Error ? e.message : String(e));
      }
    };
    const poll = () => {
      if (document.visibilityState === 'visible') void load();
      else timer = setTimeout(poll, REFRESH_MS);
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [ref.id, ref.kind]);

  const jobName = ref.job_name ?? t.dashboard.activity.jobFallback;
  const kindLabel = m.kinds[ref.kind] ?? ref.kind;
  const jobId = detail?.run.job_id ?? ref.job_id;

  const runAgain = async () => {
    if (!detail || detail.kind !== 'job' || !jobId) return;
    try {
      if (detail.run.kind === 'check') {
        await api.post(`/jobs/${jobId}/check`, detail.run.check_info?.level ? { level: detail.run.check_info.level } : {});
        toast(m.checkStarted, 'success');
      } else {
        await api.post(`/jobs/${jobId}/run`);
        toast(m.runStarted, 'success');
      }
      onStarted?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : m.runFailed, 'error');
    }
  };

  const canRunAgain =
    !!detail && detail.kind === 'job' && !!jobId && !active && (detail.run.kind === 'backup' || detail.run.kind === 'check');

  const footer = (
    <>
      <button className="btn btn-ghost" onClick={onClose}>
        {t.common.close}
      </button>
      {jobId && onEditJob && (
        <button
          className="btn btn-ghost"
          onClick={() => {
            onClose();
            onEditJob(jobId);
          }}
        >
          <Icon name="edit" size={14} />
          {m.editJob}
        </button>
      )}
      {canRunAgain && (
        <BusyButton className="btn btn-primary" onClick={runAgain}>
          <Icon name="play" size={14} />
          {m.runAgain}
        </BusyButton>
      )}
    </>
  );

  let body: ReactNode;
  if (error) body = <Empty>{error}</Empty>;
  else if (!detail) body = <Loading label={m.loading} />;
  else
    body = (
      <div className="run-detail">
        <RunFacts detail={detail} agents={agents} onOpen={setRef} jobName={ref.job_name ?? null} />
        {!jobId && <div className="run-detail-note">{m.jobDeleted}</div>}
        {detail.run.error && (
          <div className="run-detail-section">
            <div className="run-detail-heading">{m.error}</div>
            <div className="warn-box run-detail-error">{detail.run.error}</div>
          </div>
        )}
        {detail.kind === 'job' && detail.run.kind === 'backup' && (proxmox || !!detail.run.stats?.proxmoxGuests) && (
          <div className="run-detail-section">
            <div className="run-detail-heading">{m.guests}</div>
            <div className="run-detail-list">
              <ProxmoxRunItemsList runId={detail.run.id} active={isActive(detail.run.status)} />
            </div>
          </div>
        )}
        {detail.kind === 'job' && <HypervVms stats={detail.run.stats} />}
        <RunLog log={detail.run.log} active={isActive(detail.run.status)} />
      </div>
    );

  return (
    <ModalFrame title={m.title(jobName, kindLabel)} wide onClose={onClose} footer={footer} guardChanges={false}>
      {body}
    </ModalFrame>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="run-fact">
      <div className="run-fact-label">{label}</div>
      <div className="run-fact-value">{children}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'success'
      ? 'success'
      : status === 'failed'
        ? 'danger'
        : status === 'queued' || status === 'running'
          ? 'info'
          : 'muted';
  return <span className={`badge ${cls}`}>{statusLabel(status)}</span>;
}

function RunFacts({
  detail,
  agents,
  jobName,
  onOpen,
}: {
  detail: Detail;
  agents: { id: string; name: string }[];
  jobName: string | null;
  onOpen: (ref: RunRef) => void;
}) {
  const t = useT();
  const m = t.runs.detail;
  const r = detail.run;
  const agentName = r.agent_id ? (agents.find((a) => a.id === r.agent_id)?.name ?? t.jobs.row.unknownAgent) : null;
  const stats = json<Record<string, unknown>>(r.stats) ?? {};
  const num = (k: string) => (typeof stats[k] === 'number' ? (stats[k] as number) : undefined);

  const facts: ReactNode[] = [
    <Fact key="status" label={m.status}>
      <StatusBadge status={r.status} />
    </Fact>,
  ];

  if (detail.kind === 'job') {
    const run = detail.run;
    const attempt = run.attempt ?? 1;
    facts.push(
      <Fact key="trigger" label={m.trigger}>
        {run.retry_of_run_id ? m.retryTrigger(attempt) : (m.triggers[run.trigger] ?? run.trigger)}
      </Fact>,
    );
    if (run.kind === 'backup') {
      facts.push(
        <Fact key="attempt" label={m.attempt}>
          {m.attemptOf(attempt)}
          {run.retry_of_run_id && (
            <button
              type="button"
              className="link-btn"
              onClick={() => onOpen({ id: run.retry_of_run_id!, kind: 'backup', job_id: run.job_id, job_name: jobName })}
            >
              {m.previousAttempt}
            </button>
          )}
        </Fact>,
      );
    }
    if (run.kind === 'check' && run.check_info) {
      facts.push(
        <Fact key="level" label={m.kinds.check}>
          {checkLevelLabel(run.check_info)}
        </Fact>,
      );
    }
    if (run.kind === 'prune' && run.parent_run_id) {
      facts.push(
        <Fact key="parent" label={m.trigger}>
          {m.pruneOfBackup}
          <button
            type="button"
            className="link-btn"
            onClick={() => onOpen({ id: run.parent_run_id!, kind: 'backup', job_id: run.job_id, job_name: jobName })}
          >
            {m.openBackup}
          </button>
        </Fact>,
      );
    }
  } else {
    const run = detail.run;
    const dest = json<RestoreDetail['destination']>(run.destination) ?? {};
    const opts = json<NonNullable<RestoreDetail['options']>>(run.options) ?? {};
    const paths = json<string[]>(run.included_paths);
    facts.push(
      <Fact key="mode" label={m.mode}>
        {restoreModeLabel(run.mode)}
      </Fact>,
    );
    if (run.mode === 'original' || run.mode === 'alternate_path') {
      facts.push(
        <Fact key="dest" label={m.destination}>
          <span className="mono">{run.mode === 'original' ? m.destinationOriginal : dest.path || '—'}</span>
        </Fact>,
      );
      const flags = [
        opts.overwrite ? `overwrite: ${opts.overwrite}` : null,
        opts.dryRun ? m.dryRun : null,
        opts.delete ? m.deleteForeign : null,
        opts.verify ? m.verify : null,
      ].filter(Boolean);
      if (flags.length) facts.push(<Fact key="opts" label={m.options}>{flags.join(' · ')}</Fact>);
    }
    if (run.mode === 'original' || run.mode === 'alternate_path' || run.mode === 'download') {
      facts.push(
        <Fact key="paths" label={m.paths}>
          {paths && paths.length ? <span className="mono">{paths.join(', ')}</span> : m.allPaths}
        </Fact>,
      );
    }
  }

  facts.push(
    <Fact key="where" label={m.ranOn}>
      {agentName ?? m.server}
    </Fact>,
  );

  const waiting =
    detail.kind === 'job' &&
    r.status === 'queued' &&
    !!detail.run.not_before &&
    new Date(detail.run.not_before).getTime() > Date.now();
  facts.push(
    <Fact key="started" label={m.started}>
      {r.started_at ? (
        <span title={fmtRelative(r.started_at)}>{fmtDateTime(r.started_at)}</span>
      ) : waiting && detail.kind === 'job' ? (
        m.retryPending(fmtRelative(detail.run.not_before))
      ) : (
        m.notStarted
      )}
    </Fact>,
    <Fact key="finished" label={m.finished}>
      {r.finished_at ? fmtDateTime(r.finished_at) : r.started_at ? m.stillRunning : '—'}
    </Fact>,
    <Fact key="duration" label={m.duration}>
      {r.started_at ? fmtDuration(runDurationMs(r)) : '—'}
    </Fact>,
  );

  if (r.snapshot_id) {
    facts.push(
      <Fact key="snap" label={m.snapshot}>
        <span className="mono">{r.snapshot_id.slice(0, 12)}</span>
      </Fact>,
    );
  }
  if (detail.kind === 'job' && detail.run.kind === 'backup' && r.status === 'success') {
    if (num('dataAdded') != null) facts.push(<Fact key="added" label={m.dataAdded}>{fmtBytes(num('dataAdded'))}</Fact>);
    if (num('totalFilesProcessed') != null || num('totalBytesProcessed') != null) {
      facts.push(
        <Fact key="processed" label={m.processed}>
          {m.processedValue(String(num('totalFilesProcessed') ?? '—'), fmtBytes(num('totalBytesProcessed')))}
        </Fact>,
      );
    }
  }
  if (detail.kind === 'restore' && r.status === 'success') {
    const bytes = num('totalBytesProcessed') ?? num('totalBytes');
    if (bytes != null) facts.push(<Fact key="written" label={m.written}>{fmtBytes(bytes)}</Fact>);
  }

  return <div className="run-facts">{facts}</div>;
}

/** Per-VM outcomes of a Hyper-V backup. */
function HypervVms({ stats }: { stats: Record<string, unknown> | null }) {
  const m = useT().runs.detail;
  const vms = json<Record<string, unknown>>(stats)?.hypervVms as HypervVmRunResult[] | undefined;
  if (!Array.isArray(vms) || vms.length === 0) return null;
  return (
    <div className="run-detail-section">
      <div className="run-detail-heading">{m.vms}</div>
      <div className="run-detail-list">
        {vms.map((vm) => (
          <div className="row compact" key={vm.vmId}>
            <span className={`status-dot ${vm.status}`} />
            <div className="row-main">
              <div className="row-title">{vm.name}</div>
              <div className="row-sub">
                {[vm.snapshotId?.slice(0, 12), vm.consistency].filter(Boolean).join(' · ')}
                {vm.error && <div className="danger-text">{vm.error}</div>}
              </div>
            </div>
            <StatusBadge status={vm.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The tail of a run's log with a copy action for the whole log. */
function RunLog({ log, active }: { log: string | null | undefined; active: boolean }) {
  const m = useT().runs.detail;
  const toast = useToast();
  const { lines, total } = logTail(log);
  const copy = async () => {
    const ok = await copyToClipboard(log ?? '');
    toast(ok ? m.logCopied : m.copyFailed, ok ? 'success' : 'error');
  };
  return (
    <div className="run-detail-section">
      <div className="run-detail-heading run-detail-heading-row">
        <span>
          {m.log}
          {total > 0 && (
            <span className="run-detail-sub">
              {total > lines.length ? m.logTail(lines.length, total) : m.logLines(total)}
            </span>
          )}
        </span>
        {total > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
            <Icon name="copy" size={13} />
            {m.copyLog}
          </button>
        )}
      </div>
      {total > 0 ? (
        <pre className="run-log" tabIndex={0}>
          {lines.join('\n')}
        </pre>
      ) : (
        <div className="run-detail-note">{active ? m.logPending : m.noLog}</div>
      )}
    </div>
  );
}
