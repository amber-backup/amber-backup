import type { StorageChartMessages } from '../en/storageChart';

export const storageChart: StorageChartMessages = {
  empty: 'Noch keine Speichermessungen. Größen werden nach jedem erfolgreichen Backup erfasst.',
  ariaLabel: (size: string) => `Gesamter Repository-Speicher, aktuell ${size}`,
  inWindow: (delta: string) => `${delta} in diesem Zeitraum`,
  perDayAvg: (delta: string) => `Ø ${delta}/Tag`,
};
