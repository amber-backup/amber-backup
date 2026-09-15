export const dashboard = {
  subtitle: (jobs: number, agents: number, active: number) =>
    `${jobs} ${jobs === 1 ? 'job' : 'jobs'} · ${agents} ${agents === 1 ? 'agent' : 'agents'} · ${active} active`,
  refresh: 'Refresh',
  newJob: 'New job',
  activity: {
    title: 'Recent activities',
    showMaintenance: 'Show prunes & checks',
    allJobs: 'All jobs →',
    empty: 'No activities yet.',
    cancelled: 'Activity cancelled',
    cancelFailed: 'Could not cancel the activity',
    cancelTitle: 'Cancel this activity',
    duration: 'Duration',
    jobFallback: 'Job',
    pruneAfterBackup: 'prune after backup',
    manualPrune: 'manual prune',
    checkDamaged: (level: string) => `${level.toLowerCase()} — integrity errors found`,
    checkClean: (level: string) => `${level.toLowerCase()} — no errors`,
    checkStatus: (level: string, status: string) => `${level.toLowerCase()} — ${status}`,
    retryBadge: (n: number) => `retry ${n}`,
    retryPending: (n: number, when: string) => `retry ${n} — starts ${when}`,
    kinds: {
      backup: 'backup',
      prune: 'prune',
      check: 'check',
    } as Record<string, string>,
  },
  schedules: {
    title: 'Upcoming schedules',
    edit: 'Edit',
    empty: 'No scheduled jobs.',
  },
  storage: {
    title: 'Repository storage',
    timeWindow: 'Time window',
    loadFailed: 'Could not load storage history.',
    ranges: {
      d7: '7d',
      d30: '30d',
      d90: '90d',
      y1: '1y',
    },
  },
  stats: {
    successfulBackups: 'Successful backups',
    total: 'total',
    failedWeek: 'Failed (7 d)',
    needsAttention: 'needs attention',
    allGood: 'all good',
    runningOperations: 'Running operations',
    active: 'active',
    agentsOnline: 'Agents online',
    offlineCount: (n: number) => `${n} offline`,
    allOnline: 'all online',
  },
};

export type DashboardMessages = typeof dashboard;
