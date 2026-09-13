import type { NotificationsMessages } from '../en/notifications';

export const notifications: NotificationsMessages = {
  title: 'Benachrichtigungen',
  subtitle: (count: number) =>
    `${count} ${count === 1 ? 'Kanal' : 'Kanäle'} · Meldung bei Erfolg oder Fehler eines Jobs`,
  newChannel: 'Neuer Kanal',
  channels: 'Kanäle',
  empty:
    'Noch keine Kanäle. Fügen Sie E-Mail, Slack, Discord, Telegram, Teams, Gotify oder einen Webhook hinzu und verknüpfen Sie sie anschließend mit Jobs.',
  disabled: 'deaktiviert',
  sendTest: 'Testbenachrichtigung senden',
  testing: 'Wird getestet…',
  test: 'Test senden',
  testFailed: 'Test fehlgeschlagen',
  deleteTitle: 'Kanal löschen',
  deleteConfirm: (name: string) => `„${name}“ wird entfernt und von allen Jobs getrennt.`,
  deleted: 'Kanal gelöscht',
  editor: {
    editTitle: 'Kanal bearbeiten',
    newTitle: 'Neuer Kanal',
    create: 'Anlegen',
    name: 'Name',
    namePlaceholder: 'z. B. Ops-Slack',
    provider: 'Anbieter',
    enabled: 'Kanal aktiviert',
    leaveUnchanged: '(unverändert lassen)',
    saved: 'Kanal gespeichert',
    saveFailed: 'Speichern fehlgeschlagen',
  },
};
