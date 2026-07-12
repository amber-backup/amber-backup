import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Run, type Job, type Agent } from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtRelative, statusLabel } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { PageHeader, ActionButton, Loading, Spinner } from '../ui/primitives';

interface DashboardData {
  recent: Run[];
  running: number;
  failedLastWeek: number;
  successTotal: number;
}

const RUNS_PAGE = 50;
const REFRESH_MS = 4000;

export function Dashboard() {
  const { data, loading } = useAsync(() =>
    Promise.all([
      api.get<DashboardData>('/runs/dashboard'),
      api.get<Job[]>('/jobs'),
      api.get<Agent[]>('/agents').catch(() => [] as Agent[]),
    ]),
  );

  if (loading || !data) return <Loading label="Loading…" />;
  const [dash0, jobs, agents0] = data;
  return <DashboardView dash0={dash0} jobs={jobs} agents0={agents0} />;
}

function DashboardView({ dash0, jobs, agents0 }: { dash0: DashboardData; jobs: Job[]; agents0: Agent[] }) {
  const navigate = useNavigate();
  const [dash, setDash] = useState(dash0);
  const [agents, setAgents] = useState(agents0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [pageLoading, setPageLoading] = useState(false);

  const seenRef = useRef<Set<string>>(new Set());
  const offsetRef = useRef(0);
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setPageLoading(true);
    try {
      const page = await api.get<Run[]>(`/runs?limit=${RUNS_PAGE}&offset=${offsetRef.current}`);
      const fresh = page.filter((r) => !seenRef.current.has(r.id));
      fresh.forEach((r) => seenRef.current.add(r.id));
      offsetRef.current += page.length;
      if (page.length < RUNS_PAGE) doneRef.current = true;
      if (fresh.length) setRuns((cur) => [...cur, ...fresh]);
    } catch {
      doneRef.current = true;
    } finally {
      loadingRef.current = false;
      setPageLoading(false);
    }
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
      setRuns((cur) => {
        const updated = cur.map((r) => d.recent.find((x) => x.id === r.id) ?? r);
        const fresh = d.recent.filter((r) => !seenRef.current.has(r.id));
        fresh.forEach((r) => seenRef.current.add(r.id));
        return fresh.length ? [...fresh, ...updated] : updated;
      });
    } catch {
      /* transient error — try again on the next tick */
    }
  }, []);

  const nextJobs = jobs
    .filter((j) => j.enabled && j.next_run)
    .sort((a, b) => +new Date(a.next_run!) - +new Date(b.next_run!));

  return (
    <div className="dashboard">
      <PageHeader
        title="Overview"
        subtitle={`${jobs.length} jobs · ${agents.length} agents · ${dash.running} active`}
        actions={
          <>
            <button className="btn btn-ghost btn-icon" title="Refresh" onClick={() => void poll()}>
              <Icon name="refresh" size={17} />
            </button>
            <ActionButton label="New job" icon="plus" variant="primary" onClick={() => navigate('/jobs')} />
          </>
        }
      />

      <Stats dash={dash} agents={agents} />

      <div className="content-grid dashboard-grid">
        <div className="panel fill-col">
          <div className="panel-head">
            <h2>Recent runs</h2>
            <span className="link" onClick={() => navigate('/jobs')}>
              All jobs →
            </span>
          </div>
          <div className="panel-scroll" ref={scrollRef}>
            <div>
              {runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
              {pageLoading && (
                <div className="loading" style={{ padding: 16 }}>
                  <Spinner />
                </div>
              )}
              {runs.length === 0 && !pageLoading && doneRef.current && (
                <div className="empty">No backup runs yet.</div>
              )}
            </div>
            <div ref={sentinelRef} style={{ height: 1 }} />
          </div>
        </div>

        <div className="side-stack fill-col">
          <div className="panel fill-col">
            <div className="panel-head">
              <h2>Upcoming schedules</h2>
              <span className="link" onClick={() => navigate('/jobs')}>
                Edit
              </span>
            </div>
            <div className="panel-scroll">
              {nextJobs.length === 0 ? (
                <div className="empty">No scheduled jobs.</div>
              ) : (
                nextJobs.map((j) => (
                  <div className="row" key={j.id}>
                    <span className="stat-icon" style={{ background: 'var(--bg-3)', color: 'var(--text-2)' }}>
                      <Icon name="clock" size={16} />
                    </span>
                    <div className="row-main">
                      <div className="row-title">{j.name}</div>
                      <div className="row-sub">{j.cron_expr}</div>
                    </div>
                    <div className="row-meta">
                      <div style={{ fontSize: 12, color: 'var(--amber)', fontWeight: 500 }}>{fmtRelative(j.next_run)}</div>
                    </div>
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

function Stats({ dash, agents }: { dash: DashboardData; agents: Agent[] }) {
  const online = agents.filter((a) => a.status === 'online').length;
  const offline = agents.length - online;
  return (
    <div className="stats">
      <StatCard label="Successful backups" value={String(dash.successTotal)} trend="total" trendClass="neutral" icon="check" />
      <StatCard
        label="Failed (7 d)"
        value={String(dash.failedLastWeek)}
        trend={dash.failedLastWeek > 0 ? 'needs attention' : 'all good'}
        trendClass={dash.failedLastWeek > 0 ? 'down' : 'up'}
        icon="job"
      />
      <StatCard label="Running backups" value={String(dash.running)} trend="active" trendClass="neutral" icon="play" />
      <StatCard
        label="Agents online"
        value={
          <span>
            {String(online)}
            <small>{` / ${agents.length}`}</small>
          </span>
        }
        trend={offline > 0 ? `${offline} offline` : 'all online'}
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

function RunRow({ run: r }: { run: Run }) {
  const bytes = (r.stats?.dataAdded as number) ?? null;
  const pct = Math.round(((r.stats?.percentDone as number) ?? 0) * 100);

  let meta: React.ReactNode;
  if (r.status === 'running') {
    meta = (
      <div style={{ width: 110 }}>
        <div className="progress-track">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  } else if (r.status === 'success') {
    meta = (
      <div className="row-meta">
        <div style={{ fontSize: 13, fontWeight: 500 }}>{fmtBytes(bytes)}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {fmtRelative(r.finished_at ?? r.created_at)}
        </div>
      </div>
    );
  } else {
    meta = (
      <div className="row-meta" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <StatusBadge status={r.status} />
        <div className="muted" style={{ fontSize: 11.5 }}>
          {fmtRelative(r.finished_at ?? r.created_at)}
        </div>
      </div>
    );
  }

  // For failed/queued show the reason (or plain status) instead of a snapshot id.
  const sub =
    r.status === 'failed' && r.error
      ? r.error
      : r.snapshot_id
        ? r.snapshot_id.slice(0, 12)
        : statusLabel(r.status);

  return (
    <div className="row" data-run-id={r.id}>
      <span className={`status-dot ${r.status}`} />
      <div className="row-main">
        <div className="row-title">{r.job_name ?? 'Job'}</div>
        <div className="row-sub">{sub}</div>
      </div>
      {meta}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'failed' || status === 'error' ? 'danger' : status === 'queued' ? 'info' : 'muted';
  return <span className={`badge ${cls}`}>{statusLabel(status)}</span>;
}
