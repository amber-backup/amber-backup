import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, Run, Job, Agent } from '../core/api';
import { router } from '../core/router';
import { fmtBytes, fmtRelative, fmtDateTime, statusLabel } from '../core/ui';

interface Dashboard {
  recent: Run[];
  running: number;
  failedLastWeek: number;
  successTotal: number;
}

export async function renderDashboard(): Promise<Node> {
  const [dash, jobs, agents] = await Promise.all([
    api.get<Dashboard>('/runs/dashboard'),
    api.get<Job[]>('/jobs'),
    api.get<Agent[]>('/agents').catch(() => [] as Agent[]),
  ]);

  const onlineAgents = agents.filter((a) => a.status === 'online').length;
  const nextJobs = jobs
    .filter((j) => j.enabled && j.next_run)
    .sort((a, b) => +new Date(a.next_run!) - +new Date(b.next_run!))
    .slice(0, 5);

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

  const stats = h(
    'div',
    { class: 'stats' },
    statCard('Successful backups', String(dash.successTotal), 'total', 'neutral', 'check'),
    statCard(
      'Failed (7 d)',
      String(dash.failedLastWeek),
      dash.failedLastWeek > 0 ? 'needs attention' : 'all good',
      dash.failedLastWeek > 0 ? 'down' : 'up',
      'job',
    ),
    statCard('Running backups', String(dash.running), 'active', 'neutral', 'play'),
    statCard(
      'Agents online',
      h('span', {}, String(onlineAgents), h('small', {}, ` / ${agents.length}`)),
      agents.length - onlineAgents > 0 ? `${agents.length - onlineAgents} offline` : 'all online',
      agents.length - onlineAgents > 0 ? 'warn' : 'up',
      'agent',
    ),
  );

  // Recent runs panel
  const runRows =
    dash.recent.length === 0
      ? [h('div', { class: 'empty' }, 'No backup runs yet.')]
      : dash.recent.map((r) => {
          const bytes = (r.stats?.dataAdded as number) ?? null;
          const pct = Math.round(((r.stats?.percentDone as number) ?? 0) * 100);
          return h(
            'div',
            { class: 'row' },
            h('span', { class: `status-dot ${r.status}` }),
            h(
              'div',
              { class: 'row-main' },
              h('div', { class: 'row-title' }, r.job_name ?? 'Job'),
              h('div', { class: 'row-sub' }, r.snapshot_id ? r.snapshot_id.slice(0, 12) : statusLabel(r.status)),
            ),
            r.status === 'running'
              ? h(
                  'div',
                  { style: 'width:110px' },
                  h('div', { class: 'progress-track' }, h('div', { class: 'fill', style: `width:${pct}%` })),
                )
              : h(
                  'div',
                  { class: 'row-meta' },
                  h('div', { style: 'font-size:13px;font-weight:500' }, r.status === 'success' ? fmtBytes(bytes) : '—'),
                  h('div', { class: 'muted', style: 'font-size:11.5px' }, fmtRelative(r.finished_at ?? r.created_at)),
                ),
          );
        });

  const recentPanel = h(
    'div',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, 'Recent runs'),
      h('span', { class: 'link', onclick: () => router.navigate('/jobs') }, 'All jobs →'),
    ),
    ...runRows,
  );

  // Upcoming schedules
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
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', {}, 'Upcoming schedules'),
      h('span', { class: 'link', onclick: () => router.navigate('/jobs') }, 'Edit'),
    ),
    ...schedRows,
  );

  // Activity log (from recent runs)
  const logRows = dash.recent.slice(0, 6).map((r) => {
    const cls = r.status === 'success' ? 'ok' : r.status === 'failed' ? 'fail' : 'info';
    const iconName = r.status === 'success' ? 'check' : r.status === 'failed' ? 'x' : 'play';
    return h(
      'div',
      { class: 'row', style: 'padding:9px 20px' },
      h('span', { class: 'mono muted', style: 'font-size:11.5px;min-width:96px' }, fmtDateTime(r.finished_at ?? r.created_at)),
      h('span', { style: `color:var(--${cls === 'ok' ? 'success' : cls === 'fail' ? 'danger' : 'info'})` }, icon(iconName, 15)),
      h(
        'span',
        { style: 'font-size:13px;color:var(--text-2)' },
        h('strong', { style: 'color:var(--text-1);font-weight:500' }, r.job_name ?? 'Job'),
        ` ${statusLabel(r.status)}`,
        r.error ? ` — ${r.error}` : '',
      ),
    );
  });

  const activityPanel = h(
    'div',
    { class: 'panel section-gap' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Activity log')),
    ...(logRows.length ? logRows : [h('div', { class: 'empty' }, 'No activity.')]),
  );

  const refreshBtn = h(
    'button',
    { class: 'btn btn-ghost btn-icon', title: 'Refresh', onclick: () => router.navigate('/') },
    icon('refresh', 17),
  );

  return h(
    'div',
    {},
    pageHeader('Overview', `${jobs.length} jobs · ${agents.length} agents · ${dash.running} active`, [
      refreshBtn,
      actionButton('New job', 'plus', () => router.navigate('/jobs'), 'primary'),
    ]),
    stats,
    h('div', { class: 'content-grid' }, recentPanel, h('div', { class: 'side-stack' }, schedPanel)),
    activityPanel,
  );
}
