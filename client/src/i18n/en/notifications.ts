export const notifications = {
  title: 'Notifications',
  subtitle: (count: number) =>
    `${count} ${count === 1 ? 'channel' : 'channels'} · alert on job success or failure`,
  newChannel: 'New channel',
  channels: 'Channels',
  empty:
    'No channels yet. Add email, Slack, Discord, Telegram, Teams, Gotify or a webhook — then attach them to jobs.',
  disabled: 'disabled',
  sendTest: 'Send a test notification',
  testing: 'Testing…',
  test: 'Test',
  testFailed: 'Test failed',
  deleteTitle: 'Delete channel',
  deleteConfirm: (name: string) => `"${name}" will be removed and detached from all jobs.`,
  deleted: 'Channel deleted',
  editor: {
    editTitle: 'Edit channel',
    newTitle: 'New channel',
    create: 'Create',
    name: 'Name',
    namePlaceholder: 'e.g. Ops Slack',
    provider: 'Provider',
    enabled: 'Channel enabled',
    leaveUnchanged: '(leave unchanged)',
    saved: 'Channel saved',
    saveFailed: 'Save failed',
  },
};

export type NotificationsMessages = typeof notifications;
