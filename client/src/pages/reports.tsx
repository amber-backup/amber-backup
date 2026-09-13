import { useState, type ReactNode } from 'react';
import { api, type Report, type Job, type NotificationChannel } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { describeCron } from '../core/cron';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, BusyButton } from '../ui/primitives';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';

const WINDOWS: Report['dataset']['window'][] = ['24h', '7d', '30d', '90d', '6mo', '12mo'];

/** Common report schedules; 'custom' frees the raw cron field. */
const CRON_PRESETS: { key: keyof Messages['reports']['presets']; value: string }[] = [
  { key: 'daily', value: '0 8 * * *' },
  { key: 'weekly', value: '0 8 * * 1' },
  { key: 'monthly', value: '0 8 1 * *' },
  { key: 'custom', value: 'custom' },
];

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
  const t = useT();
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

  if (loading || !data) return <Loading label={t.common.loading} />;
  const [reports, jobs, channels] = data;

  const newReport = () =>
    open((close) => (
      <ReportEditor jobs={jobs} channels={channels} onClose={close} onSaved={reload} />
    ));

  return (
    <div>
      <PageHeader
        title={t.reports.title}
        subtitle={t.reports.subtitle(reports.length)}
        actions={<ActionButton label={t.reports.newReport} icon="plus" variant="primary" onClick={newReport} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{t.reports.definitions}</h2>
        </div>
        {reports.length === 0 ? (
          <Empty>{t.reports.empty}</Empty>
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
  const t = useT();
  const m = t.reports.row;
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
          {tags.map((tag, i) => (
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
              {tag}
            </span>
          ))}
        </div>
        <div className="row-sub">
          {m.summary(jobCount, t.reports.windows[r.dataset?.window] ?? r.dataset?.window ?? '—', channelCount, r.cron_expr)}
        </div>
      </div>
      <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
        <div>
          {m.last}{' '}
          <span style={r.last_run_at ? undefined : { color: 'var(--text-3)' }}>
            {fmtRelative(r.last_run_at)}
          </span>
        </div>
        {r.enabled && r.next_run ? (
          <div>
            {m.next} <span style={{ color: 'var(--amber)' }}>{fmtRelative(r.next_run)}</span>
          </div>
        ) : (
          <div className="muted">{m.disabled}</div>
        )}
      </div>
      <div className="row-actions">
        <BusyButton
          className="btn btn-primary btn-sm"
          title={m.sendNow}
          onClick={async () => {
            try {
              await api.post(`/reports/${r.id}/run`);
              toast(m.sent, 'success');
            } catch (err) {
              toast(err instanceof Error ? err.message : m.sendFailed, 'error');
            }
          }}
        >
          <Icon name="send" size={15} />
        </BusyButton>
        <button
          className="btn btn-ghost btn-sm"
          title={m.edit}
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
          title={t.common.delete}
          onClick={() =>
            confirmDialog(
              m.deleteTitle,
              m.deleteConfirm(r.name),
              async () => {
                await api.del(`/reports/${r.id}`);
                toast(m.deleted, 'success');
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
  const t = useT();
  const m = t.reports.editor;
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
      toast(m.nameRequired, 'error');
      return false;
    }
    if (jobIds.length === 0) {
      toast(m.selectJob, 'error');
      return false;
    }
    if (statusSel.length === 0) {
      toast(m.selectOutcome, 'error');
      return false;
    }
    if (channelIds.length === 0) {
      toast(m.selectChannel, 'error');
      return false;
    }

    const payload = {
      name: name.trim(),
      tags: tagsText
        .split(',')
        .map((tag) => tag.trim())
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
      toast(m.saved, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : m.saveFailed, 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={isEdit ? m.editTitle : m.newTitle}
      wide
      confirmLabel={isEdit ? t.common.save : m.create}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="modal-form">
        {section(
          m.general,
          '',
          <Field key="name" label={m.name}>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>,
          <Field key="tags" label={m.tags} help={m.tagsHelp}>
            <input
              type="text"
              value={tagsText}
              placeholder="weekly, ops"
              onChange={(e) => setTagsText(e.target.value)}
            />
          </Field>,
          <label key="enabled" className="checkbox">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {m.enabled}
          </label>,
        )}
        {section(
          m.dataset,
          m.datasetSub,
          jobs.length === 0 ? (
            <div key="nojobs" className="help">
              {m.noJobs}
            </div>
          ) : (
            <Field key="jobs" label={m.jobs} help={m.jobsHelp}>
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
          <Field key="outcomes" label={m.outcomes}>
            <div className="field-row">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={success}
                  onChange={(e) => setSuccess(e.target.checked)}
                />
                {m.successes}
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={failed}
                  onChange={(e) => setFailed(e.target.checked)}
                />
                {m.failures}
              </label>
            </div>
          </Field>,
          <Field key="window" label={m.timeWindow}>
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as Report['dataset']['window'])}
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {t.reports.windows[w]}
                </option>
              ))}
            </select>
          </Field>,
        )}
        {section(
          m.schedule,
          m.scheduleSub,
          <Field key="preset" label={m.preset}>
            <select
              value={preset}
              onChange={(e) => {
                if (e.target.value !== 'custom') setCron(e.target.value);
              }}
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {t.reports.presets[p.key]}
                </option>
              ))}
            </select>
          </Field>,
          <Field key="cron" label={m.cron} help={m.cronHelp}>
            <input
              type="text"
              value={cron}
              placeholder="0 8 * * 1"
              onChange={(e) => setCron(e.target.value)}
            />
          </Field>,
          <div key="preview" className={`cron-preview${cronDesc ? '' : ' invalid'}`}>
            {`→ ${cronDesc ?? m.customSchedule}`}
          </div>,
        )}
        {section(
          m.delivery,
          m.deliverySub,
          channels.length === 0 ? (
            <div key="nochannels" className="help">
              {m.noChannels}
            </div>
          ) : (
            <Field key="channels" label={m.channels}>
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
