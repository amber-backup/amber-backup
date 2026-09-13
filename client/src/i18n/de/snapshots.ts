import type { SnapshotsMessages } from '../en/snapshots';

export const snapshots: SnapshotsMessages = {
  page: {
    back: 'Zurück',
    title: 'Snapshots',
    subtitleJob: 'Repository prüfen, Snapshots durchsuchen und gezielt oder vollständig wiederherstellen',
    subtitleList: 'Wählen Sie einen Job, um seine Snapshots zu durchsuchen und sein Repository zu prüfen',
    jobNotFound: 'Dieser Job existiert nicht oder Sie haben keinen Zugriff darauf.',
  },
  jobList: {
    title: (count: number) => `Jobs (${count})`,
    empty: 'Noch keine Backup-Jobs.',
    agent: 'Agent',
    local: 'Lokal',
    sizeUnknown: 'Größe unbekannt',
    sizeSummary: (size: string, count: number | string) => `${size} · ${count} Snapshots`,
  },
  list: {
    loading: 'Snapshots werden geladen…',
    empty: 'Keine Snapshots in diesem Repository.',
    title: (job: string, count?: number) => `${job} — Snapshots${count != null ? ` (${count})` : ''}`,
    browse: 'Durchsuchen',
    restore: 'Wiederherstellen',
    deleteSnapshot: 'Snapshot löschen',
  },
  deleteDialog: {
    title: 'Snapshot löschen',
    deleted: 'Snapshot gelöscht',
    deletedPruning: 'Snapshot gelöscht — Prune gestartet, siehe letzte Aktivitäten',
    failed: 'Löschen fehlgeschlagen',
    warning: (shortId: string, time: string) =>
      `Snapshot ${shortId} (${time}) wird endgültig entfernt. Dies kann nicht rückgängig gemacht werden.`,
    prune: 'Zusätzlich jetzt Prune ausführen — Speicher sofort freigeben (langsamer, sperrt das Repository)',
  },
  browser: {
    title: (shortId: string) => `Snapshot ${shortId} durchsuchen`,
    restoreSelected: 'Auswahl wiederherstellen',
    emptyDir: 'Leeres Verzeichnis.',
    selected: (count: number) => `${count} ausgewählt`,
  },
  restore: {
    title: (paths: number) =>
      paths ? `Wiederherstellen (${paths} ${paths === 1 ? 'Pfad' : 'Pfade'})` : 'Wiederherstellen',
    confirm: 'Wiederherstellen',
    dryRunStarted: 'Testlauf gestartet — siehe Verlauf',
    started: 'Wiederherstellung gestartet',
    mode: 'Modus',
    modeDownload: 'Herunterladen (Archiv)',
    modeAlternate: 'Alternativer Pfad (Server)',
    modeOriginal: 'Ursprünglicher Ort',
    targetPath: 'Zielpfad',
    overwrite: 'Überschreiben',
    overwriteAlways: 'always (alles überschreiben)',
    verify: 'Verifizieren (--verify)',
    deleteForeign: 'Fremde Dateien löschen (--delete)',
    deleteWarning: '⚠ Achtung: --delete entfernt Dateien im Ziel, die nicht im Snapshot enthalten sind.',
    dryRun: 'Testlauf',
  },
  history: {
    title: 'Wiederherstellungsverlauf',
    empty: 'Noch keine Wiederherstellungen.',
    modeOriginal: 'Ursprünglich',
    modeAlternate: 'Alt. Pfad',
    modeDownload: 'Download',
    download: 'Herunterladen',
  },
};
