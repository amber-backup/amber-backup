export const storageChart = {
  empty: 'No storage readings yet. Sizes are recorded after each successful backup.',
  ariaLabel: (size: string) => `Total repository storage, ${size} now`,
  inWindow: (delta: string) => `${delta} in this window`,
  perDayAvg: (delta: string) => `${delta}/day avg`,
};

export type StorageChartMessages = typeof storageChart;
