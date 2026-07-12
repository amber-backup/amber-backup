import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, Run, Job, Agent } from '../core/api';
import { router } from '../core/router';
import { fmtBytes, fmtRelative, statusLabel } from '../core/ui';

interface Dashboard {
  recent: Run[];
  running: number;
  failedLastWeek: number;
  successTotal: number;
}

const RUNS_PAGE = 50;

export async function renderDashboard(): Promise<Node> {
  const [dash, jobs, agents] = await Promise.all([
    api.get<Dashboard>('/runs/dashboard'),
    api.get<Job[]>('/jobs'),
    api.get<Agent[]>('/agents').catch(() => [] as Agent[]),
  ]);

  const nextJobs = jobs
    .filter((j) => j.enabled && j.next_run)
    .sort((a, b) => +new Date(a.next_run!) - +new Date(b.next_run!));

  const statCard = (
    label: string,
    value: string | Node,
    trend: string,
    trendClass: string,
    iconName: string,
  ) =>
    h(
      'div',
      { class: 'stat' },
      h(
        'div',
        { class: 'stat-head' },
        h('span', { class: 'stat-label' }, label),
        h('span', { class: 'stat-icon' }, icon(iconName, 16)),
      ),
      h('div', { class: 'stat-value' }, value),
      h('div', { class: `stat-trend ${trendClass}` }, trend),
    );

  // Rebuilt on each live refresh so the tiles track running jobs and agent state.
  const buildStats = (d: Dashboard, ag: Agent[]): HTMLElement[] => {
    const online = ag.filter((a) => a.status === 'online').length;
    const offline = ag.length - online;
    return [
      statCard('Successful backups', String(d.successTotal), 'total', 'neutral', 'check'),
      statCard(
        'Failed (7 d)',
        String(d.failedLastWeek),
        d.failedLastWeek > 0 ? 'needs attention' : 'all good',
        d.failedLastWeek > 0 ? 'down' : 'up',
        'job',
      ),
      statCard('Running backups', String(d.running), 'active', 'neutral', 'play'),
      statCard(
        'Agents online',
        h('span', {}, String(online), h('small', {}, ` / ${ag.length}`)),
        offline > 0 ? `${offline} offline` : 'all online',
        offline > 0 ? 'warn' : 'up',
        'agent',
      ),
    ];
  };

  let latestAgents = agents;
  const stats = h('div', { class: 'stats' }, ...buildStats(dash, latestAgents));

  // --- Recent runs (paginated, infinite scroll) ---
  const runsList = h('div', {});
  const runsScroll = h('div', { class: 'panel-scroll' }, runsList);

  const recentPanel = h(
    'div',
    { class: 'panel fill-col' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, 'Recent runs'),
      h('span', { class: 'link', onclick: () => router.navigate('/jobs') }, 'All jobs →'),
    ),
    runsScroll,
  );

  let offset = 0;
  let loading = false;
  let done = false;
  // Run ids already in the DOM — shared by pagination and the live refresh so a
  // run that the poller prepended is never appended again by a later page.
  const seen = new Set<string>();
  const loadMoreRuns = async (): Promise<void> => {
    if (loading || done) return;
    loading = true;
    const spinner = h('div', { class: 'loading', style: 'padding:16px' }, h('span', { class: 'spinner' }));
    runsList.append(spinner);
    try {
      const page = await api.get<Run[]>(`/runs?limit=${RUNS_PAGE}&offset=${offset}`);
      spinner.remove();
      page.forEach((r) => {
        if (seen.has(r.id)) return;
        seen.add(r.id);
        runsList.append(runRow(r));
      });
      offset += page.length;
      if (page.length < RUNS_PAGE) done = true;
      if (offset === 0) runsList.append(h('div', { class: 'empty' }, 'No backup runs yet.'));
    } catch {
      spinner.remove();
      done = true;
      if (offset === 0) runsList.append(h('div', { class: 'empty' }, 'Failed to load runs.'));
    } finally {
      loading = false;
    }
  };

  // Sentinel at the bottom of the scroller triggers the next page.
  const sentinel = h('div', { style: 'height:1px' });
  runsScroll.append(sentinel);
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMoreRuns().then(scheduleRecheck);
    },
    { root: runsScroll, rootMargin: '250px' },
  );
  // If the first page doesn't fill the viewport, keep pulling until it does.
  const scheduleRecheck = () => {
    if (!done && !loading && sentinel.getBoundingClientRect().top < runsScroll.getBoundingClientRect().bottom + 250) {
      void loadMoreRuns().then(scheduleRecheck);
    }
  };
  io.observe(sentinel);

  await loadMoreRuns();

  // --- Live refresh -------------------------------------------------------
  // The dashboard is otherwise static; poll while it is mounted so running
  // jobs' progress bars advance and the stat tiles / agent state stay current.
  const applyRuns = (recent: Run[]): void => {
    // Update rows already shown (progress advances; running → success/failed).
    for (const r of recent) {
      const existing = runsList.querySelector(`[data-run-id="${r.id}"]`);
      if (existing) existing.replaceWith(runRow(r));
    }
    // Prepend runs that started since load (oldest-first so newest ends on top).
    const fresh = recent.filter((r) => !seen.has(r.id));
    for (let i = fresh.length - 1; i >= 0; i--) {
      runsList.querySelector('.empty')?.remove();
      runsList.prepend(runRow(fresh[i]));
      seen.add(fresh[i].id);
    }
  };

  const REFRESH_MS = 4000;
  const timer = setInterval(() => {
    // Stop once the page is navigated away (its nodes leave the document).
    if (!runsScroll.isConnected) {
      clearInterval(timer);
      return;
    }
    if (document.visibilityState !== 'visible') return;
    void (async () => {
      try {
        const [d, ag] = await Promise.all([
          api.get<Dashboard>('/runs/dashboard'),
          api.get<Agent[]>('/agents').catch(() => null),
        ]);
        if (ag) latestAgents = ag;
        stats.replaceChildren(...buildStats(d, latestAgents));
        applyRuns(d.recent);
      } catch {
        /* transient error — try again on the next tick */
      }
    })();
  }, REFRESH_MS);

  // --- Upcoming schedules ---
  const schedRows =
    nextJobs.length === 0
      ? [h('div', { class: 'empty' }, 'No scheduled jobs.')]
      : nextJobs.map((j) =>
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'stat-icon', style: 'background:var(--bg-3);color:var(--text-2)' }, icon('clock', 16)),
            h(
              'div',
              { class: 'row-main' },
              h('div', { class: 'row-title' }, j.name),
              h('div', { class: 'row-sub' }, j.cron_expr),
            ),
            h(
              'div',
              { class: 'row-meta' },
              h('div', { style: 'font-size:12px;color:var(--amber);font-weight:500' }, fmtRelative(j.next_run)),
            ),
          ),
        );

  const schedPanel = h(
    'div',
    { class: 'panel fill-col' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, 'Upcoming schedules'),
      h('span', { class: 'link', onclick: () => router.navigate('/jobs') }, 'Edit'),
    ),
    h('div', { class: 'panel-scroll' }, ...schedRows),
  );

  const refreshBtn = h(
    'button',
    { class: 'btn btn-ghost btn-icon', title: 'Refresh', onclick: () => router.navigate('/') },
    icon('refresh', 17),
  );

  return h(
    'div',
    { class: 'dashboard' },
    pageHeader('Overview', `${jobs.length} jobs · ${agents.length} agents · ${dash.running} active`, [
      refreshBtn,
      actionButton('New job', 'plus', () => router.navigate('/jobs'), 'primary'),
    ]),
    stats,
    h('div', { class: 'content-grid dashboard-grid' }, recentPanel, h('div', { class: 'side-stack fill-col' }, schedPanel)),
  );
}

/** A single recent-run row, showing running progress and queued/failed states. */
function runRow(r: Run): HTMLElement {
  const bytes = (r.stats?.dataAdded as number) ?? null;
  const pct = Math.round(((r.stats?.percentDone as number) ?? 0) * 100);

  let meta: Node;
  if (r.status === 'running') {
    meta = h(
      'div',
      { style: 'width:110px' },
      h('div', { class: 'progress-track' }, h('div', { class: 'fill', style: `width:${pct}%` })),
    );
  } else if (r.status === 'success') {
    meta = h(
      'div',
      { class: 'row-meta' },
      h('div', { style: 'font-size:13px;font-weight:500' }, fmtBytes(bytes)),
      h('div', { class: 'muted', style: 'font-size:11.5px' }, fmtRelative(r.finished_at ?? r.created_at)),
    );
  } else {
    meta = h(
      'div',
      { class: 'row-meta', style: 'display:flex;flex-direction:column;align-items:flex-end;gap:3px' },
      statusBadge(r.status),
      h('div', { class: 'muted', style: 'font-size:11.5px' }, fmtRelative(r.finished_at ?? r.created_at)),
    );
  }

  // For failed/queued show the reason (or plain status) instead of a snapshot id.
  const sub =
    r.status === 'failed' && r.error
      ? r.error
      : r.snapshot_id
        ? r.snapshot_id.slice(0, 12)
        : statusLabel(r.status);

  return h(
    'div',
    { class: 'row', 'data-run-id': r.id },
    h('span', { class: `status-dot ${r.status}` }),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, r.job_name ?? 'Job'),
      h('div', { class: 'row-sub' }, sub),
    ),
    meta,
  );
}

function statusBadge(status: string): HTMLElement {
  const cls =
    status === 'failed' || status === 'error'
      ? 'danger'
      : status === 'queued'
        ? 'info'
        : 'muted';
  return h('span', { class: `badge ${cls}` }, statusLabel(status));
}
