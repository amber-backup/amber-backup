import { h } from '../core/dom';
import { icon } from '../core/icons';
import { pageHeader, actionButton } from '../core/layout';
import { api, Job, Target, Agent, NotificationChannel } from '../core/api';
import { router } from '../core/router';
import { openModal, toast, field, confirmDialog, fmtRelative } from '../core/ui';

export async function renderJobs(): Promise<Node> {
  const [jobs, targets, agents, channels] = await Promise.all([
    api.get<Job[]>('/jobs'),
    api.get<Target[]>('/targets'),
    api.get<Agent[]>('/agents').catch(() => [] as Agent[]),
    // Channels are admin-only; non-admins simply get an empty list.
    api.get<NotificationChannel[]>('/notification-channels').catch(() => [] as NotificationChannel[]),
  ]);

  const panel = h(
    'div',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Backup jobs')),
    ...(jobs.length === 0
      ? [h('div', { class: 'empty' }, 'No jobs yet. Define what to back up, where to, and on which schedule.')]
      : jobs.map((j) => jobRow(j, targets, agents, channels))),
  );

  return h(
    'div',
    {},
    pageHeader('Jobs', `${jobs.length} backup jobs`, [
      actionButton('New job', 'plus', () => openEditor(targets, agents, channels), 'primary'),
    ]),
    panel,
  );
}

function jobRow(j: Job, targets: Target[], agents: Agent[], channels: NotificationChannel[]): HTMLElement {
  const tgt = targets.find((t) => t.id === j.target_id);
  const agent = agents.find((a) => a.id === j.agent_id);
  const where = j.location === 'agent' ? `Agent: ${agent?.name ?? 'unknown'}` : 'Local';
  return h(
    'div',
    { class: 'row' },
    h('span', { class: `status-dot ${j.enabled ? 'online' : 'offline'}` }),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, j.name),
      h('div', { class: 'row-sub' }, `${where} · ${j.paths.join(', ')} → ${tgt?.name ?? '?'} · ${j.cron_expr}`),
    ),
    h(
      'div',
      { class: 'row-meta', style: 'font-size:12px;color:var(--text-2)' },
      j.enabled && j.next_run ? h('span', {}, 'next ', h('span', { style: 'color:var(--amber)' }, fmtRelative(j.next_run))) : h('span', { class: 'muted' }, 'disabled'),
    ),
    h(
      'div',
      { class: 'row-actions' },
      h(
        'button',
        {
          class: 'btn btn-primary btn-sm',
          title: 'Back up now',
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            btn.setAttribute('disabled', '');
            try {
              await api.post(`/jobs/${j.id}/run`);
              toast('Backup started', 'success');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Start failed', 'error');
            } finally {
              btn.removeAttribute('disabled');
            }
          },
        },
        icon('play', 15),
      ),
      h('button', { class: 'btn btn-ghost btn-sm', title: 'Edit', onclick: () => openEditor(targets, agents, channels, j) }, icon('edit')),
      h('button', { class: 'btn btn-ghost btn-sm', title: 'Duplicate', onclick: () => openEditor(targets, agents, channels, j, true) }, icon('copy')),
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          title: 'Delete',
          onclick: () =>
            confirmDialog('Delete job', `"${j.name}" will be removed.`, async () => {
              await api.del(`/jobs/${j.id}`);
              toast('Job deleted', 'success');
              router.navigate('/jobs');
            }, true),
        },
        icon('trash'),
      ),
    ),
  );
}

function numInput(name: string, value?: number): HTMLInputElement {
  return h('input', { type: 'number', name, min: '0', value: value != null ? String(value) : '', placeholder: '—' }) as HTMLInputElement;
}

/** A titled group of fields in the job editor. */
function section(title: string, sub: string, ...children: (Node | null)[]): HTMLElement {
  return h(
    'div',
    { class: 'form-section' },
    h('div', { class: 'form-section-title' }, title, sub ? h('span', { class: 'sub' }, sub) : null),
    ...children,
  );
}

/** Common cron schedules offered as presets; 'custom' frees the raw field. */
const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 03:00', value: '0 3 * * *' },
  { label: 'Weekly — Sunday 03:00', value: '0 3 * * 0' },
  { label: 'Monthly — 1st, 03:00', value: '0 3 1 * *' },
  { label: 'Custom…', value: 'custom' },
];

/** Human-readable summary of a cron expression, or null if not recognized. */
function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, hr, dom, mon, dow] = parts;
  const isNum = (s: string): boolean => /^\d+$/.test(s);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const at = isNum(hr) && isNum(m) ? `${hr.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (m === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  if (m === '0' && /^\*\/\d+$/.test(hr) && dom === '*' && mon === '*' && dow === '*') return `Every ${hr.slice(2)} hours`;
  if (at && dom === '*' && mon === '*' && dow === '*') return `Every day at ${at}`;
  if (at && dom === '*' && mon === '*' && isNum(dow)) return `Every week on ${days[Number(dow) % 7]} at ${at}`;
  if (at && isNum(dom) && mon === '*' && dow === '*') return `Every month on day ${dom} at ${at}`;
  return null;
}

function openEditor(targets: Target[], agents: Agent[], channels: NotificationChannel[], job?: Job, duplicate = false): void {
  // Duplicate: prefill from an existing job but create a new one (POST).
  const isEdit = !!job && !duplicate;
  const isDuplicate = !!job && duplicate;
  const opts = (job?.restic_options ?? {}) as Record<string, any>;
  const ret = (opts.retention ?? {}) as Record<string, any>;

  const nameInput = h('input', { type: 'text', value: isDuplicate ? `Copy of ${job!.name}` : (job?.name ?? '') });

  const tagsInput = h('input', { type: 'text', value: (opts.tags ?? []).join(', '), placeholder: 'daily, important' });
  const enabledCheck = h('input', { type: 'checkbox', checked: job ? job.enabled : true }) as HTMLInputElement;

  // Source: where to run (server or a specific agent) + paths + excludes.
  // A single dropdown lists the server plus every agent — no second step.
  const currentWhere = job?.location === 'agent' ? job.agent_id ?? '' : 'local';
  const whereSelect = h(
    'select',
    {},
    h('option', { value: 'local', selected: currentWhere === 'local' }, 'Server (this host)'),
    ...agents.map((a) => h('option', { value: a.id, selected: currentWhere === a.id }, `${a.name} (${a.status})`)),
  );
  const pathsInput = h('textarea', { placeholder: '/home\n/etc\n/var/www' }, (job?.paths ?? []).join('\n'));
  const excludeInput = h('textarea', { placeholder: '*.tmp\n/var/cache' }, (opts.exclude ?? []).join('\n'));

  const targetSelect = h('select', {}, ...targets.map((t) => h('option', { value: t.id, selected: job?.target_id === t.id }, t.name)));

  // Schedule: a preset dropdown fills the cron field, and a live description
  // makes the raw expression legible.
  const cronInput = h('input', { type: 'text', value: job?.cron_expr ?? '0 3 * * *', placeholder: '0 3 * * *' }) as HTMLInputElement;
  const presetSelect = h('select', {}, ...CRON_PRESETS.map((p) => h('option', { value: p.value }, p.label))) as HTMLSelectElement;
  const cronPreview = h('div', { class: 'cron-preview' });
  const matchPreset = (): string =>
    CRON_PRESETS.find((p) => p.value === cronInput.value.trim())?.value ?? 'custom';
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

  const keepLast = numInput('keepLast', ret.keepLast);
  const keepDaily = numInput('keepDaily', ret.keepDaily);
  const keepWeekly = numInput('keepWeekly', ret.keepWeekly);
  const keepMonthly = numInput('keepMonthly', ret.keepMonthly);
  const pruneCheck = h('input', { type: 'checkbox', checked: !!ret.prune }) as HTMLInputElement;

  // Notifications: which channels to alert, and on which outcomes. Sensible
  // defaults for a new job — alert on failure only.
  const notify = job?.notify ?? {};
  const selected = new Set(notify.channelIds ?? []);
  const onFailureCheck = h('input', { type: 'checkbox', checked: job ? !!notify.onFailure : true }) as HTMLInputElement;
  const onSuccessCheck = h('input', { type: 'checkbox', checked: job ? !!notify.onSuccess : false }) as HTMLInputElement;
  const channelChecks = channels.map((c) => ({
    c,
    cb: h('input', { type: 'checkbox', checked: selected.has(c.id) }) as HTMLInputElement,
  }));
  const notifySection = section('Notifications', 'alert on job result',
    ...(channels.length === 0
      ? [h('div', { class: 'help' }, 'No channels configured. An admin can add them under Notifications.')]
      : [
          h('div', { class: 'field-row' },
            h('label', { class: 'checkbox' }, onFailureCheck, 'On failure'),
            h('label', { class: 'checkbox' }, onSuccessCheck, 'On success'),
          ),
          field('Channels', h('div', { class: 'channel-picker' },
            ...channelChecks.map((x) => h('label', { class: 'checkbox' }, x.cb, x.c.name)),
          )),
        ]),
  );

  const body = h(
    'div',
    { class: 'modal-form' },
    section('General', '',
      field('Name', nameInput),
      field('Tags', tagsInput, 'Comma-separated labels added to each snapshot'),
      h('label', { class: 'checkbox' }, enabledCheck, 'Job enabled'),
    ),
    section('Source', 'what to back up',
      field('Run on', whereSelect, 'The server itself, or a remote agent'),
      field('Paths', pathsInput, 'One path per line'),
      field('Excludes', excludeInput, 'One glob or path per line'),
    ),
    section('Destination', 'where to store it',
      field('Target', targetSelect),
    ),
    section('Schedule', 'when it runs',
      field('Preset', presetSelect),
      field('Cron', cronInput, 'minute hour day month weekday'),
      cronPreview,
    ),
    section('Retention', 'how long to keep snapshots',
      h('div', { class: 'field-row' }, field('keep-last', keepLast), field('keep-daily', keepDaily)),
      h('div', { class: 'field-row' }, field('keep-weekly', keepWeekly), field('keep-monthly', keepMonthly)),
      h('label', { class: 'checkbox' }, pruneCheck, 'Prune after forget (reclaim storage)'),
    ),
    notifySection,
  );

  openModal({
    title: isEdit ? 'Edit job' : isDuplicate ? 'Duplicate job' : 'New job',
    body,
    wide: true,
    confirmLabel: isEdit ? 'Save' : 'Create',
    onConfirm: async () => {
      const retention: Record<string, unknown> = {};
      const setNum = (k: string, el: HTMLInputElement) => {
        if (el.value !== '') retention[k] = Number(el.value);
      };
      setNum('keepLast', keepLast);
      setNum('keepDaily', keepDaily);
      setNum('keepWeekly', keepWeekly);
      setNum('keepMonthly', keepMonthly);
      if (pruneCheck.checked) retention.prune = true;

      const resticOptions: Record<string, unknown> = {
        tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
        exclude: excludeInput.value.split('\n').map((t) => t.trim()).filter(Boolean),
      };
      if (Object.keys(retention).length) resticOptions.retention = retention;

      const paths = pathsInput.value.split('\n').map((p) => p.trim()).filter(Boolean);

      // 'local' means the server; any other value is an agent id.
      const where = whereSelect.value;
      const location = where === 'local' ? 'local' : 'agent';
      const agentId = where === 'local' ? undefined : where;

      const notifyPayload = {
        channelIds: channelChecks.filter((x) => x.cb.checked).map((x) => x.c.id),
        onSuccess: onSuccessCheck.checked,
        onFailure: onFailureCheck.checked,
      };

      try {
        if (isEdit) {
          await api.patch(`/jobs/${job!.id}`, {
            name: nameInput.value,
            location,
            agentId,
            paths,
            cronExpr: cronInput.value,
            resticOptions,
            notify: notifyPayload,
            enabled: enabledCheck.checked,
          });
        } else {
          const payload: Record<string, unknown> = {
            name: nameInput.value,
            location,
            paths,
            targetId: targetSelect.value,
            cronExpr: cronInput.value,
            resticOptions,
            notify: notifyPayload,
            enabled: enabledCheck.checked,
          };
          if (agentId) payload.agentId = agentId;
          await api.post('/jobs', payload);
        }
        toast('Job saved', 'success');
        router.navigate('/jobs');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Save failed', 'error');
        return false;
      }
    },
  });
}
