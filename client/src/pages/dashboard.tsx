import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type Run, type Job, type Agent, type RepositoryStatsHistory } from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtDuration, fmtRelative, runDurationMs, statusLabel } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { PageHeader, ActionButton, Loading, Spinner } from '../ui/primitives';
import { useToast } from '../ui/toast';
import { StorageChart, StorageSummary } from '../ui/storage-chart';
import { checkLevelLabel } from '../ui/integrity';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';

interface DashboardData {
  recent: Run[];
  running: number;
  failedLastWeek: number;
  successTotal: number;
}

const RUNS_PAGE = 50;
/** Time windows offered for the storage growth chart. */
const STORAGE_RANGES: { key: keyof Messages['dashboard']['storage']['ranges']; days: number }[] = [
  { key: 'd7', days: 7 },
  { key: 'd30', days: 30 },
  { key: 'd90', days: 90 },
  { key: 'y1', days: 365 },
];
// Poll fairly briskly so running backups show near-live progress (bytes/percent).
const REFRESH_MS = 2000;

export function Dashboard() {
  const t = useT();
  const { data, loading } = useAsync(() =>
    Promise.all([
      api.get<DashboardData>('/runs/dashboard'),
      api.get<Job[]>('/jobs'),
      api.get<Agent[]>('/agents').catch(() => [] as Agent[]),
    ]),
  );

  if (loading || !data) return <Loading label={t.common.loading} />;
  const [dash0, jobs, agents0] = data;
  return <DashboardView dash0={dash0} jobs={jobs} agents0={agents0} />;
}

function DashboardView({ dash0, jobs, agents0 }: { dash0: DashboardData; jobs: Job[]; agents0: Agent[] }) {
  const t = useT();
  const navigate = useNavigate();
  const [dash, setDash] = useState(dash0);
  const [agents, setAgents] = useState(agents0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [pageLoading, setPageLoading] = useState(false);
  // Maintenance (prunes, integrity checks) is noise next to the backups, so it
  // stays hidden until asked for.
  const [showMaintenance, setShowMaintenance] = useState(false);

  const seenRef = useRef<Set<string>>(new Set());
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Bumped when the filter changes so a page still in flight for the previous
  // filter is discarded instead of mixed into the list.
  const genRef = useRef(0);
  // The poll timer is installed once, so it reads the filter through a ref.
  const showMaintenanceRef = useRef(showMaintenance);
  showMaintenanceRef.current = showMaintenance;
  // Same for the rows, so a poll can see which ones still need a live status.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  // Runs cancelled from this page. A local abort settles its row a moment
  // later, so until the server agrees, a stale `running` must not win.
  const cancelledRef = useRef<Set<string>>(new Set());

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setPageLoading(true);
    const gen = genRef.current;
    try {
      const kind = showMaintenance ? '' : '&kind=backup';
      const page = await api.get<Run[]>(`/runs?limit=${RUNS_PAGE}&offset=${offsetRef.current}${kind}`);
      if (gen !== genRef.current) return;
      const fresh = page.filter((r) => !seenRef.current.has(r.id));
      fresh.forEach((r) => seenRef.current.add(r.id));
      offsetRef.current += page.length;
      if (page.length < RUNS_PAGE) doneRef.current = true;
      if (fresh.length) setRuns((cur) => [...cur, ...fresh]);
    } catch {
      if (gen === genRef.current) doneRef.current = true;
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false;
        setPageLoading(false);
      }
    }
  }, [showMaintenance]);

  // Toggling the filter starts the list over: the offset and the seen-ids set
  // belong to the previous query. The load effect re-runs on the new filter.
  const toggleShowMaintenance = useCallback((next: boolean): void => {
    genRef.current += 1;
    seenRef.current = new Set();
    offsetRef.current = 0;
    loadingRef.current = false;
    doneRef.current = false;
    setRuns([]);
    setPageLoading(false);
    setShowMaintenance(next);
  }, []);

  // Keep pulling pages until the scroller is filled (first page may be short).
  const fillViewport = useCallback(async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      const sc = scrollRef.current;
      const sn = sentinelRef.current;
      if (doneRef.current || loadingRef.current || !sc || !sn) break;
      if (sn.getBoundingClientRect().top >= sc.getBoundingClientRect().bottom + 250) break;
      await loadMore();
    }
  }, [loadMore]);

  // Initial page + infinite-scroll observer.
  useEffect(() => {
    void loadMore().then(fillViewport);
    const sc = scrollRef.current;
    const sn = sentinelRef.current;
    if (!sc || !sn) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore().then(fillViewport);
      },
      { root: sc, rootMargin: '250px' },
    );
    io.observe(sn);
    return () => io.disconnect();
  }, [loadMore, fillViewport]);

  // Live refresh: advance running progress and keep stats/agents current.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void poll();
    }, REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    try {
      const [d, ag] = await Promise.all([
        api.get<DashboardData>('/runs/dashboard'),
        api.get<Agent[]>('/agents').catch(() => null),
      ]);
      if (ag) setAgents(ag);
      setDash(d);
      // `recent` covers every activity, so drop maintenance while it's hidden.
      const recent = showMaintenanceRef.current ? d.recent : d.recent.filter((r) => r.kind === 'backup');
      // `recent` is only the newest few, so an older row that is still queued or
      // running (typically a hung one) is fetched on its own to stay current.
      const stale = runsRef.current.filter(
        (r) => isActive(r.status) && !recent.some((x) => x.id === r.id),
      );
      const refetched = await Promise.all(
        stale.map((r) =>
          api
            .get<Run & { log?: unknown }>(`/runs/${r.id}`)
            .then(({ log: _log, ...fresh }) => ({ ...r, ...fresh }))
            .catch(() => null),
        ),
      );
      const latest = [...recent, ...refetched.filter((r): r is Run => r !== null)];
      const merge = (r: Run): Run => {
        const fresh = latest.find((x) => x.id === r.id);
        if (!fresh) return r;
        if (cancelledRef.current.has(r.id)) {
          if (isActive(fresh.status)) return r;
          cancelledRef.current.delete(r.id);
        }
        return fresh;
      };
      setRuns((cur) => {
        const updated = cur.map(merge);
        const fresh = recent.filter((r) => !seenRef.current.has(r.id));
        fresh.forEach((r) => seenRef.current.add(r.id));
        return fresh.length ? [...fresh, ...updated] : updated;
      });
    } catch {
      /* transient error — try again on the next tick */
    }
  }, []);

  const markCancelled = (id: string) => {
    cancelledRef.current.add(id);
    const now = new Date().toISOString();
    setRuns((cur) =>
      cur.map((r) => (r.id === id ? { ...r, status: 'cancelled', finished_at: r.finished_at ?? now } : r)),
    );
    void poll();
  };

  const nextJobs = jobs
    .filter((j) => j.enabled && j.next_run)
    .sort((a, b) => +new Date(a.next_run!) - +new Date(b.next_run!));

  return (
    <div className="dashboard">
      <PageHeader
        title={t.common.nav.overview}
        subtitle={t.dashboard.subtitle(jobs.length, agents.length, dash.running)}
        actions={
          <>
            <button className="btn btn-ghost btn-icon" title={t.dashboard.refresh} onClick={() => void poll()}>
              <Icon name="refresh" size={17} />
            </button>
            <ActionButton label={t.dashboard.newJob} icon="plus" variant="primary" onClick={() => navigate('/jobs')} />
          </>
        }
      />

      <Stats dash={dash} agents={agents} />

      <div className="content-grid dashboard-grid">
        <div className="main-stack fill-col">
          <StoragePanel />

          <div className="panel fill-col">
            <div className="panel-head">
              <h2>{t.dashboard.activity.title}</h2>
              <div className="panel-head-actions">
                <label className="checkbox sm">
                  <input
                    type="checkbox"
                    checked={showMaintenance}
                    onChange={(e) => toggleShowMaintenance(e.target.checked)}
                  />
                  {t.dashboard.activity.showMaintenance}
                </label>
                <span className="link" onClick={() => navigate('/jobs')}>
                  {t.dashboard.activity.allJobs}
                </span>
              </div>
            </div>
            <div className="panel-scroll" ref={scrollRef}>
              <div>
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} onCancelled={() => markCancelled(r.id)} />
                ))}
                {pageLoading && (
                  <div className="loading" style={{ padding: 16 }}>
                    <Spinner />
                  </div>
                )}
                {runs.length === 0 && !pageLoading && doneRef.current && (
                  <div className="empty">{t.dashboard.activity.empty}</div>
                )}
              </div>
              <div ref={sentinelRef} style={{ height: 1 }} />
            </div>
          </div>
        </div>

        <div className="side-stack fill-col">
          <div className="panel fill-col">
            <div className="panel-head">
              <h2>{t.dashboard.schedules.title}</h2>
              <span className="link" onClick={() => navigate('/jobs')}>
                {t.dashboard.schedules.edit}
              </span>
            </div>
            <div className="panel-scroll">
              {nextJobs.length === 0 ? (
                <div className="empty">{t.dashboard.schedules.empty}</div>
              ) : (
                nextJobs.map((j) => (
                  <div className="row compact" key={j.id} title={fmtDateTime(j.next_run)}>
                    <div className="row-main">
                      <div className="row-title">{j.name}</div>
                      <div className="row-sub">{j.cron_expr}</div>
                    </div>
                    <div className="row-meta schedule-next">{fmtRelative(j.next_run)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Repository storage growth over a selectable window. */
function StoragePanel() {
  const t = useT();
  const [days, setDays] = useState(7);
  const { data, loading, error } = useAsync(
    () => api.get<RepositoryStatsHistory>(`/repositories/stats-history?days=${days}`),
    [days],
  );

  return (
    <div className="panel fill-col">
      <div className="panel-head">
        <div className="panel-title-group">
          <h2>{t.dashboard.storage.title}</h2>
          {data && <StorageSummary history={data} />}
        </div>
        <div className="seg" role="group" aria-label={t.dashboard.storage.timeWindow}>
          {STORAGE_RANGES.map((r) => (
            <button
              key={r.days}
              className={`seg-btn${r.days === days ? ' active' : ''}`}
              onClick={() => setDays(r.days)}
            >
              {t.dashboard.storage.ranges[r.key]}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <div className="empty">{t.dashboard.storage.loadFailed}</div>
      ) : loading && !data ? (
        <div className="loading" style={{ padding: 16 }}>
          <Spinner />
        </div>
      ) : (
        data && <StorageChart history={data} />
      )}
    </div>
  );
}

function Stats({ dash, agents }: { dash: DashboardData; agents: Agent[] }) {
  const t = useT();
  const s = t.dashboard.stats;
  const online = agents.filter((a) => a.status === 'online').length;
  const offline = agents.length - online;
  return (
    <div className="stats">
      <StatCard label={s.successfulBackups} value={String(dash.successTotal)} trend={s.total} trendClass="neutral" icon="check" />
      <StatCard
        label={s.failedWeek}
        value={String(dash.failedLastWeek)}
        trend={dash.failedLastWeek > 0 ? s.needsAttention : s.allGood}
        trendClass={dash.failedLastWeek > 0 ? 'down' : 'up'}
        icon="job"
      />
      <StatCard label={s.runningOperations} value={String(dash.running)} trend={s.active} trendClass="neutral" icon="play" />
      <StatCard
        label={s.agentsOnline}
        value={
          <span>
            {String(online)}
            <small>{` / ${agents.length}`}</small>
          </span>
        }
        trend={offline > 0 ? s.offlineCount(offline) : s.allOnline}
        trendClass={offline > 0 ? 'warn' : 'up'}
        icon="agent"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  trend,
  trendClass,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  trend: string;
  trendClass: string;
  icon: string;
}) {
  return (
    <div className="stat">
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        <span className="stat-icon">
          <Icon name={icon} size={16} />
        </span>
      </div>
      <div className="stat-value">{value}</div>
      <div className={`stat-trend ${trendClass}`}>{trend}</div>
    </div>
  );
}

function RunRow({ run: r, onCancelled }: { run: Run; onCancelled: () => void }) {
  const t = useT();
  const a = t.dashboard.activity;
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const bytes = (r.stats?.dataAdded as number) ?? null;

  const bytesDone = r.stats?.bytesDone as number | undefined;
  const totalBytes = r.stats?.totalBytes as number | undefined;

  // Derive the percentage from the bytes done/total when available — this tracks
  // the data actually written and doesn't depend on restic's (rounded, and early
  // sometimes 0) percent_done. Fall back to percent_done, then 0.
  const frac =
    totalBytes && totalBytes > 0 && bytesDone != null
      ? bytesDone / totalBytes
      : ((r.stats?.percentDone as number) ?? 0);
  const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
  const duration = fmtDuration(runDurationMs(r));

  // Queued and running activities can be stopped; a hung one is force-cancelled
  // server-side so it stops sitting in the list forever.
  const cancellable = isActive(r.status);

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.post(`/runs/${r.id}/cancel`);
      toast(a.cancelled, 'success');
      onCancelled();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : a.cancelFailed, 'error');
    } finally {
      setCancelling(false);
    }
  };

  const cancelButton = cancellable && (
    <button
      className="run-cancel"
      title={a.cancelTitle}
      aria-label={a.cancelTitle}
      disabled={cancelling}
      onClick={() => void cancel()}
    >
      <Icon name="x" size={12} />
    </button>
  );

  let meta: React.ReactNode;
  if (r.kind !== 'backup') {
    // A prune or check has no progress or snapshot: outcome, duration and time.
    meta = (
      <div className="row-meta run-meta">
        <span>
          {cancelButton}
          {r.status !== 'success' && <StatusBadge status={r.status} />}
        </span>
        <span className="muted" title={a.duration}>
          {r.started_at ? duration : ''}
        </span>
        <span className="muted">{fmtRelative(r.finished_at ?? r.created_at)}</span>
      </div>
    );
  } else if (r.status === 'running') {
    meta = (
      <div className="row-meta run-progress">
        {cancelButton}
        <div className="progress-track">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="run-progress-labels">
          <span>{totalBytes != null ? `${fmtBytes(bytesDone ?? 0)} / ${fmtBytes(totalBytes)}` : ''}</span>
          <span>{pct}%</span>
        </div>
      </div>
    );
  } else if (r.status === 'success') {
    meta = (
      <div className="row-meta run-meta">
        <span style={{ fontWeight: 500 }}>{fmtBytes(bytes)}</span>
        <span className="muted" title={a.duration}>
          {duration}
        </span>
        <span className="muted">{fmtRelative(r.finished_at ?? r.created_at)}</span>
      </div>
    );
  } else {
    meta = (
      <div className="row-meta run-meta">
        <span>
          {cancelButton}
          <StatusBadge status={r.status} />
        </span>
        <span className="muted" title={a.duration}>
          {r.started_at ? duration : ''}
        </span>
        <span className="muted">{fmtRelative(r.finished_at ?? r.created_at)}</span>
      </div>
    );
  }

  // For failed/queued show the reason (or plain status) instead of a snapshot id;
  // a running activity shows how long it has been going.
  // A retry still waiting out its delay says when it starts.
  const retry = (r.attempt ?? 1) - 1;
  const retryWaiting =
    r.status === 'queued' && !!r.not_before && new Date(r.not_before).getTime() > Date.now();
  const sub = retryWaiting
    ? a.retryPending(retry, fmtRelative(r.not_before))
    : r.status === 'failed' && r.error
      ? r.error
      : r.status === 'running' && r.started_at
        ? `${statusLabel(r.status)} · ${duration}`
        : r.kind === 'check'
          ? checkSub(r, t)
          : r.kind === 'prune'
            ? r.parent_run_id
              ? a.pruneAfterBackup
              : a.manualPrune
            : r.snapshot_id
              ? r.snapshot_id.slice(0, 12)
              : statusLabel(r.status);

  return (
    <div className="row compact" data-run-id={r.id}>
      <span className={`status-dot ${r.status}`} />
      <div className="row-main">
        <div className="row-title">
          {r.job_name ?? a.jobFallback}
          {r.kind !== 'backup' && (
            <span className={`badge ${r.check_info?.damaged ? 'danger' : 'muted'} row-kind`}>
              {a.kinds[r.kind] ?? r.kind}
            </span>
          )}
          {retry > 0 && <span className="badge muted row-kind">{a.retryBadge(retry)}</span>}
        </div>
        <div className="row-sub">{sub}</div>
      </div>
      {meta}
    </div>
  );
}

/** Sub line of a finished or queued check: what it read and what it found. */
function checkSub(r: Run, t: Messages): string {
  const a = t.dashboard.activity;
  const what = checkLevelLabel(r.check_info);
  if (r.check_info?.damaged) return a.checkDamaged(what);
  if (r.status === 'success') return a.checkClean(what);
  return a.checkStatus(what, statusLabel(r.status));
}

function isActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'failed' || status === 'error' ? 'danger' : status === 'queued' ? 'info' : 'muted';
  return <span className={`badge ${cls}`}>{statusLabel(status)}</span>;
}
