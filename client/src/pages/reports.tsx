import { useState, type ReactNode } from 'react';
import { api, type Report, type Job, type NotificationChannel } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, BusyButton } from '../ui/primitives';

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

/** A titled group of fields in the report editor. */
function section(title: string, sub: string, ...children: ReactNode[]): ReactNode {
  return (
    <div className="form-section">
      <div className="form-section-title">
        {title}
        {sub ? <span className="sub">{sub}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function Reports() {
  const { data, loading, reload } = useAsync(() =>
    Promise.all([
      api.get<Report[]>('/reports'),
      api.get<Job[]>('/jobs').catch(() => [] as Job[]),
      api
        .get<NotificationChannel[]>('/notification-channels')
        .catch(() => [] as NotificationChannel[]),
    ]),
  );
  const { open } = useModal();

  if (loading || !data) return <Loading label="Loading…" />;
  const [reports, jobs, channels] = data;

  const newReport = () =>
    open((close) => (
      <ReportEditor jobs={jobs} channels={channels} onClose={close} onSaved={reload} />
    ));

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={`${reports.length} report definitions`}
        actions={<ActionButton label="New report" icon="plus" variant="primary" onClick={newReport} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>Report definitions</h2>
        </div>
        {reports.length === 0 ? (
          <Empty>
            No reports yet. Summarize job successes and failures over a time window and have them
            delivered on a schedule.
          </Empty>
        ) : (
          reports.map((r) => (
            <ReportRow key={r.id} report={r} jobs={jobs} channels={channels} reload={reload} />
          ))
        )}
      </div>
    </div>
  );
}

function ReportRow({
  report: r,
  jobs,
  channels,
  reload,
}: {
  report: Report;
  jobs: Job[];
  channels: NotificationChannel[];
  reload: () => void;
}) {
  const toast = useToast();
  const { open, confirmDialog } = useModal();
  const jobCount = r.dataset?.jobIds?.length ?? 0;
  const channelCount = r.channel_ids?.length ?? 0;
  const tags = r.tags ?? [];

  return (
    <div className="row">
      <span className={`status-dot ${r.enabled ? 'online' : 'offline'}`} />
      <div className="row-main">
        <div className="row-title">
          {r.name}
          {tags.map((t, i) => (
            <span
              key={i}
              className="pill"
              style={{
                marginLeft: 6,
                fontSize: 11,
                padding: '1px 7px',
                background: 'var(--amber-glow)',
                color: 'var(--amber)',
                borderRadius: 10,
              }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="row-sub">
          {`${jobCount} job(s) · ${WINDOW_LABELS[r.dataset?.window] ?? r.dataset?.window ?? '—'} · ${channelCount} channel(s) · ${r.cron_expr}`}
        </div>
      </div>
      <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
        <div>
          last{' '}
          <span style={r.last_run_at ? undefined : { color: 'var(--text-3)' }}>
            {fmtRelative(r.last_run_at)}
          </span>
        </div>
        {r.enabled && r.next_run ? (
          <div>
            next <span style={{ color: 'var(--amber)' }}>{fmtRelative(r.next_run)}</span>
          </div>
        ) : (
          <div className="muted">disabled</div>
        )}
      </div>
      <div className="row-actions">
        <BusyButton
          className="btn btn-primary btn-sm"
          title="Generate and send now"
          onClick={async () => {
            try {
              await api.post(`/reports/${r.id}/run`);
              toast('Report sent', 'success');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Send failed', 'error');
            }
          }}
        >
          <Icon name="send" size={15} />
        </BusyButton>
        <button
          className="btn btn-ghost btn-sm"
          title="Edit"
          onClick={() =>
            open((close) => (
              <ReportEditor
                jobs={jobs}
                channels={channels}
                report={r}
                onClose={close}
                onSaved={reload}
              />
            ))
          }
        >
          <Icon name="edit" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title="Delete"
          onClick={() =>
            confirmDialog(
              'Delete report',
              `"${r.name}" will be removed.`,
              async () => {
                await api.del(`/reports/${r.id}`);
                toast('Report deleted', 'success');
                reload();
              },
              true,
            )
          }
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

function ReportEditor({
  jobs,
  channels,
  report,
  onClose,
  onSaved,
}: {
  jobs: Job[];
  channels: NotificationChannel[];
  report?: Report;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isEdit = !!report;
  const dataset = report?.dataset;

  const [name, setName] = useState(report?.name ?? '');
  const [tagsText, setTagsText] = useState((report?.tags ?? []).join(', '));
  const [enabled, setEnabled] = useState(report ? report.enabled : true);

  // Dataset: which jobs, which outcomes, over which window.
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(
    () => new Set(dataset?.jobIds ?? []),
  );
  const initialStatuses = dataset?.statuses ?? ['success', 'failed'];
  const [success, setSuccess] = useState(initialStatuses.includes('success'));
  const [failed, setFailed] = useState(initialStatuses.includes('failed'));
  const [window, setWindow] = useState<Report['dataset']['window']>(dataset?.window ?? '7d');

  const toggleJob = (id: string) =>
    setSelectedJobs((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Schedule: a preset dropdown fills the cron field, with a live description.
  const [cron, setCron] = useState(report?.cron_expr ?? '0 8 * * 1');
  const matchPreset = (value: string): string =>
    CRON_PRESETS.find((p) => p.value === value.trim())?.value ?? 'custom';
  const preset = matchPreset(cron);
  const cronDesc = describeCron(cron);

  // Delivery: which channels receive the rendered report.
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(
    () => new Set(report?.channel_ids ?? []),
  );
  const toggleChannel = (id: string) =>
    setSelectedChannels((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    const jobIds = jobs.filter((j) => selectedJobs.has(j.id)).map((j) => j.id);
    const statusSel: ('success' | 'failed')[] = [];
    if (success) statusSel.push('success');
    if (failed) statusSel.push('failed');
    const channelIds = channels.filter((c) => selectedChannels.has(c.id)).map((c) => c.id);

    if (!name.trim()) {
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
      name: name.trim(),
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      dataset: {
        jobIds,
        statuses: statusSel,
        window,
      },
      cronExpr: cron,
      channelIds,
      enabled,
    };

    try {
      if (isEdit) {
        await api.patch(`/reports/${report!.id}`, payload);
      } else {
        await api.post('/reports', payload);
      }
      toast('Report saved', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={isEdit ? 'Edit report' : 'New report'}
      wide
      confirmLabel={isEdit ? 'Save' : 'Create'}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="modal-form">
        {section(
          'General',
          '',
          <Field key="name" label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>,
          <Field key="tags" label="Tags" help="Comma-separated labels">
            <input
              type="text"
              value={tagsText}
              placeholder="weekly, ops"
              onChange={(e) => setTagsText(e.target.value)}
            />
          </Field>,
          <label key="enabled" className="checkbox">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Report enabled
          </label>,
        )}
        {section(
          'Dataset',
          'what to report',
          jobs.length === 0 ? (
            <div key="nojobs" className="help">
              No jobs available. Create backup jobs first.
            </div>
          ) : (
            <Field key="jobs" label="Jobs" help="Runs from these jobs are counted">
              <div className="channel-picker">
                {jobs.map((j) => (
                  <label key={j.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={selectedJobs.has(j.id)}
                      onChange={() => toggleJob(j.id)}
                    />
                    {j.name}
                  </label>
                ))}
              </div>
            </Field>
          ),
          <Field key="outcomes" label="Outcomes">
            <div className="field-row">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={success}
                  onChange={(e) => setSuccess(e.target.checked)}
                />
                Successes
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={failed}
                  onChange={(e) => setFailed(e.target.checked)}
                />
                Failures
              </label>
            </div>
          </Field>,
          <Field key="window" label="Time window">
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as Report['dataset']['window'])}
            >
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </Field>,
        )}
        {section(
          'Schedule',
          'when it is sent',
          <Field key="preset" label="Preset">
            <select
              value={preset}
              onChange={(e) => {
                if (e.target.value !== 'custom') setCron(e.target.value);
              }}
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>,
          <Field key="cron" label="Cron" help="minute hour day month weekday">
            <input
              type="text"
              value={cron}
              placeholder="0 8 * * 1"
              onChange={(e) => setCron(e.target.value)}
            />
          </Field>,
          <div key="preview" className={`cron-preview${cronDesc ? '' : ' invalid'}`}>
            {`→ ${cronDesc ?? 'Custom schedule'}`}
          </div>,
        )}
        {section(
          'Delivery',
          'where to send it',
          channels.length === 0 ? (
            <div key="nochannels" className="help">
              No channels configured. Add them under Notifications.
            </div>
          ) : (
            <Field key="channels" label="Channels">
              <div className="channel-picker">
                {channels.map((c) => (
                  <label key={c.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={selectedChannels.has(c.id)}
                      onChange={() => toggleChannel(c.id)}
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </Field>
          ),
        )}
      </div>
    </FormModal>
  );
}
