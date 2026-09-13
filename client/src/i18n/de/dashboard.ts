import type { DashboardMessages } from '../en/dashboard';

export const dashboard: DashboardMessages = {
  subtitle: (jobs: number, agents: number, active: number) =>
    `${jobs} ${jobs === 1 ? 'Job' : 'Jobs'} · ${agents} ${agents === 1 ? 'Agent' : 'Agents'} · ${active} aktiv`,
  refresh: 'Aktualisieren',
  newJob: 'Neuer Job',
  activity: {
    title: 'Letzte Aktivitäten',
    showMaintenance: 'Prunes & Prüfungen anzeigen',
    allJobs: 'Alle Jobs →',
    empty: 'Noch keine Aktivitäten.',
    cancelled: 'Aktivität abgebrochen',
    cancelFailed: 'Die Aktivität konnte nicht abgebrochen werden',
    cancelTitle: 'Diese Aktivität abbrechen',
    duration: 'Dauer',
    jobFallback: 'Job',
    pruneAfterBackup: 'Prune nach Backup',
    manualPrune: 'manueller Prune',
    checkDamaged: (level: string) => `${level} — Integritätsfehler gefunden`,
    checkClean: (level: string) => `${level} — keine Fehler`,
    checkStatus: (level: string, status: string) => `${level} — ${status}`,
    kinds: {
      backup: 'Backup',
      prune: 'Prune',
      check: 'Prüfung',
    } as Record<string, string>,
  },
  schedules: {
    title: 'Anstehende Zeitpläne',
    edit: 'Bearbeiten',
    empty: 'Keine geplanten Jobs.',
  },
  storage: {
    title: 'Repository-Speicher',
    timeWindow: 'Zeitraum',
    loadFailed: 'Der Speicherverlauf konnte nicht geladen werden.',
    ranges: {
      d7: '7 T',
      d30: '30 T',
      d90: '90 T',
      y1: '1 J',
    },
  },
  stats: {
    successfulBackups: 'Erfolgreiche Backups',
    total: 'gesamt',
    failedWeek: 'Fehlgeschlagen (7 T)',
    needsAttention: 'Handlungsbedarf',
    allGood: 'alles in Ordnung',
    runningOperations: 'Laufende Vorgänge',
    active: 'aktiv',
    agentsOnline: 'Agents online',
    offlineCount: (n: number) => `${n} offline`,
    allOnline: 'alle online',
  },
};
