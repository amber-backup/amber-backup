import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, Report, Job, NotificationChannel } from '../core/api';
import { router } from '../core/router';
import {
  openModal,
  toast,
  field,
  confirmDialog,
  fmtRelative,
} from '../core/ui';

export async function renderReports(): Promise<Node> {
  const [reports, jobs, channels] = await Promise.all([
    api.get<Report[]>('/reports'),
    api.get<Job[]>('/jobs').catch(() => [] as Job[]),
    api
      .get<NotificationChannel[]>('/notification-channels')
      .catch(() => [] as NotificationChannel[]),
  ]);

  const panel = h(
    'div',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Report definitions')),
    ...(reports.length === 0
      ? [
          h(
            'div',
            { class: 'empty' },
            'No reports yet. Summarize job successes and failures over a time window and have them delivered on a schedule.',
          ),
        ]
      : reports.map((r) => reportRow(r, jobs, channels))),
  );

  return h(
    'div',
    {},
    pageHeader('Reports', `${reports.length} report definitions`, [
      actionButton(
        'New report',
        'plus',
        () => openEditor(jobs, channels),
        'primary',
      ),
    ]),
    panel,
  );
}

function reportRow(
  r: Report,
  jobs: Job[],
  channels: NotificationChannel[],
): HTMLElement {
  const jobCount = r.dataset?.jobIds?.length ?? 0;
  const channelCount = r.channel_ids?.length ?? 0;
  const tags = r.tags ?? [];
  return h(
    'div',
    { class: 'row' },
    h('span', { class: `status-dot ${r.enabled ? 'online' : 'offline'}` }),
    h(
      'div',
      { class: 'row-main' },
      h(
        'div',
        { class: 'row-title' },
        r.name,
        ...tags.map((t) =>
          h(
            'span',
            {
              class: 'pill',
              style:
                'margin-left:6px;font-size:11px;padding:1px 7px;background:var(--amber-glow);color:var(--amber);border-radius:10px',
            },
            t,
          ),
        ),
      ),
      h(
        'div',
        { class: 'row-sub' },
        `${jobCount} job(s) · ${WINDOW_LABELS[r.dataset?.window] ?? r.dataset?.window ?? '—'} · ${channelCount} channel(s) · ${r.cron_expr}`,
      ),
    ),
    h(
      'div',
      { class: 'row-meta', style: 'font-size:12px;color:var(--text-2)' },
      h(
        'div',
        {},
        'last ',
        h(
          'span',
          { style: r.last_run_at ? '' : 'color:var(--text-3)' },
          fmtRelative(r.last_run_at),
        ),
      ),
      r.enabled && r.next_run
        ? h(
            'div',
            {},
            'next ',
            h('span', { style: 'color:var(--amber)' }, fmtRelative(r.next_run)),
          )
        : h('div', { class: 'muted' }, 'disabled'),
    ),
    h(
      'div',
      { class: 'row-actions' },
      h(
        'button',
        {
          class: 'btn btn-primary btn-sm',
          title: 'Generate and send now',
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled', '');
            try {
              await api.post(`/reports/${r.id}/run`);
              toast('Report sent', 'success');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Send failed', 'error');
            } finally {
              btn.removeAttribute('disabled');
            }
          },
        },
        icon('send', 15),
      ),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          title: 'Edit',
          onclick: () => openEditor(jobs, channels, r),
        },
        icon('edit'),
      ),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          title: 'Delete',
          onclick: () =>
            confirmDialog(
              'Delete report',
              `"${r.name}" will be removed.`,
              async () => {
                await api.del(`/reports/${r.id}`);
                toast('Report deleted', 'success');
                router.navigate('/reports');
              },
              true,
            ),
        },
        icon('trash'),
      ),
    ),
  );
}

/** A titled group of fields in the report editor. */
function section(
  title: string,
  sub: string,
  ...children: (Node | null)[]
): HTMLElement {
  return h(
    'div',
    { class: 'form-section' },
    h(
      'div',
      { class: 'form-section-title' },
      title,
      sub ? h('span', { class: 'sub' }, sub) : null,
    ),
    ...children,
  );
}

const WINDOWS: { label: string; value: Report['dataset']['window'] }[] = [
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 90 days', value: '90d' },
  { label: 'Last 6 months', value: '6mo' },
  { label: 'Last 12 months', value: '12mo' },
];

const WINDOW_LABELS: Record<string, string> = Object.fromEntries(
  WINDOWS.map((w) => [w.value, w.label]),
);

/** Common report schedules; 'custom' frees the raw cron field. */
const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Daily at 08:00', value: '0 8 * * *' },
  { label: 'Weekly — Monday 08:00', value: '0 8 * * 1' },
  { label: 'Monthly — 1st, 08:00', value: '0 8 1 * *' },
  { label: 'Custom…', value: 'custom' },
];

/** Human-readable summary of a cron expression, or null if not recognized. */
function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, hr, dom, mon, dow] = parts;
  const isNum = (s: string): boolean => /^\d+$/.test(s);
  const days = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const at =
    isNum(hr) && isNum(m) ? `${hr.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (m === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*')
    return 'Every hour';
  if (at && dom === '*' && mon === '*' && dow === '*')
    return `Every day at ${at}`;
  if (at && dom === '*' && mon === '*' && isNum(dow))
    return `Every week on ${days[Number(dow) % 7]} at ${at}`;
  if (at && isNum(dom) && mon === '*' && dow === '*')
    return `Every month on day ${dom} at ${at}`;
  return null;
}

function openEditor(
  jobs: Job[],
  channels: NotificationChannel[],
  report?: Report,
): void {
  const isEdit = !!report;
  const dataset = report?.dataset;

  const nameInput = h('input', {
    type: 'text',
    value: report?.name ?? '',
  }) as HTMLInputElement;
  const tagsInput = h('input', {
    type: 'text',
    value: (report?.tags ?? []).join(', '),
    placeholder: 'weekly, ops',
  }) as HTMLInputElement;
  const enabledCheck = h('input', {
    type: 'checkbox',
    checked: report ? report.enabled : true,
  }) as HTMLInputElement;

  // Dataset: which jobs, which outcomes, over which window.
  const selectedJobs = new Set(dataset?.jobIds ?? []);
  const jobChecks = jobs.map((j) => ({
    j,
    cb: h('input', {
      type: 'checkbox',
      checked: selectedJobs.has(j.id),
    }) as HTMLInputElement,
  }));
  const statuses = dataset?.statuses ?? ['success', 'failed'];
  const successCheck = h('input', {
    type: 'checkbox',
    checked: statuses.includes('success'),
  }) as HTMLInputElement;
  const failedCheck = h('input', {
    type: 'checkbox',
    checked: statuses.includes('failed'),
  }) as HTMLInputElement;
  const windowSelect = h(
    'select',
    {},
    ...WINDOWS.map((w) =>
      h(
        'option',
        { value: w.value, selected: (dataset?.window ?? '7d') === w.value },
        w.label,
      ),
    ),
  ) as HTMLSelectElement;

  const datasetSection = section(
    'Dataset',
    'what to report',
    jobs.length === 0
      ? h(
          'div',
          { class: 'help' },
          'No jobs available. Create backup jobs first.',
        )
      : field(
          'Jobs',
          h(
            'div',
            { class: 'channel-picker' },
            ...jobChecks.map((x) =>
              h('label', { class: 'checkbox' }, x.cb, x.j.name),
            ),
          ),
          'Runs from these jobs are counted',
        ),
    field(
      'Outcomes',
      h(
        'div',
        { class: 'field-row' },
        h('label', { class: 'checkbox' }, successCheck, 'Successes'),
        h('label', { class: 'checkbox' }, failedCheck, 'Failures'),
      ),
    ),
    field('Time window', windowSelect),
  );

  // Schedule: a preset dropdown fills the cron field, with a live description.
  const cronInput = h('input', {
    type: 'text',
    value: report?.cron_expr ?? '0 8 * * 1',
    placeholder: '0 8 * * 1',
  }) as HTMLInputElement;
  const presetSelect = h(
    'select',
    {},
    ...CRON_PRESETS.map((p) => h('option', { value: p.value }, p.label)),
  ) as HTMLSelectElement;
  const cronPreview = h('div', { class: 'cron-preview' });
  const matchPreset = (): string =>
    CRON_PRESETS.find((p) => p.value === cronInput.value.trim())?.value ??
    'custom';
  const refreshCron = (): void => {
    const desc = describeCron(cronInput.value);
    cronPreview.textContent = `→ ${desc ?? 'Custom schedule'}`;
    cronPreview.classList.toggle('invalid', !desc);
  };
  presetSelect.value = matchPreset();
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value !== 'custom') cronInput.value = presetSelect.value;
    refreshCron();
  });
  cronInput.addEventListener('input', () => {
    presetSelect.value = matchPreset();
    refreshCron();
  });
  refreshCron();

  // Delivery: which channels receive the rendered report.
  const selectedChannels = new Set(report?.channel_ids ?? []);
  const channelChecks = channels.map((c) => ({
    c,
    cb: h('input', {
      type: 'checkbox',
      checked: selectedChannels.has(c.id),
    }) as HTMLInputElement,
  }));

  const body = h(
    'div',
    { class: 'modal-form' },
    section(
      'General',
      '',
      field('Name', nameInput),
      field('Tags', tagsInput, 'Comma-separated labels'),
      h('label', { class: 'checkbox' }, enabledCheck, 'Report enabled'),
    ),
    datasetSection,
    section(
      'Schedule',
      'when it is sent',
      field('Preset', presetSelect),
      field('Cron', cronInput, 'minute hour day month weekday'),
      cronPreview,
    ),
    section(
      'Delivery',
      'where to send it',
      channels.length === 0
        ? h(
            'div',
            { class: 'help' },
            'No channels configured. Add them under Notifications.',
          )
        : field(
            'Channels',
            h(
              'div',
              { class: 'channel-picker' },
              ...channelChecks.map((x) =>
                h('label', { class: 'checkbox' }, x.cb, x.c.name),
              ),
            ),
          ),
    ),
  );

  openModal({
    title: isEdit ? 'Edit report' : 'New report',
    body,
    wide: true,
    confirmLabel: isEdit ? 'Save' : 'Create',
    onConfirm: async () => {
      const jobIds = jobChecks.filter((x) => x.cb.checked).map((x) => x.j.id);
      const statusSel: ('success' | 'failed')[] = [];
      if (successCheck.checked) statusSel.push('success');
      if (failedCheck.checked) statusSel.push('failed');
      const channelIds = channelChecks
        .filter((x) => x.cb.checked)
        .map((x) => x.c.id);

      if (!nameInput.value.trim()) {
        toast('Name is required', 'error');
        return false;
      }
      if (jobIds.length === 0) {
        toast('Select at least one job', 'error');
        return false;
      }
      if (statusSel.length === 0) {
        toast('Select at least one outcome', 'error');
        return false;
      }
      if (channelIds.length === 0) {
        toast('Select at least one channel', 'error');
        return false;
      }

      const payload = {
        name: nameInput.value.trim(),
        tags: tagsInput.value
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        dataset: {
          jobIds,
          statuses: statusSel,
          window: windowSelect.value as Report['dataset']['window'],
        },
        cronExpr: cronInput.value,
        channelIds,
        enabled: enabledCheck.checked,
      };

      try {
        if (isEdit) {
          await api.patch(`/reports/${report!.id}`, payload);
        } else {
          await api.post('/reports', payload);
        }
        toast('Report saved', 'success');
        router.navigate('/reports');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Save failed', 'error');
        return false;
      }
    },
  });
}
