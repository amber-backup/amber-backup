import { useState, type ReactNode } from 'react';
import { api, type Job, type Target, type Agent, type NotificationChannel } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, BusyButton } from '../ui/primitives';

export function Jobs() {
  const { data, loading, reload } = useAsync(() =>
    Promise.all([
      api.get<Job[]>('/jobs'),
      api.get<Target[]>('/targets'),
      api.get<Agent[]>('/agents').catch(() => [] as Agent[]),
      // Channels are admin-only; non-admins simply get an empty list.
      api.get<NotificationChannel[]>('/notification-channels').catch(() => [] as NotificationChannel[]),
    ]),
  );
  const { open } = useModal();

  if (loading || !data) return <Loading label="Loading…" />;
  const [jobs, targets, agents, channels] = data;

  const newJob = () =>
    open((close) => (
      <JobEditor targets={targets} agents={agents} channels={channels} onClose={close} onSaved={reload} />
    ));

  return (
    <div>
      <PageHeader
        title="Jobs"
        subtitle={`${jobs.length} backup jobs`}
        actions={<ActionButton label="New job" icon="plus" variant="primary" onClick={newJob} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>Backup jobs</h2>
        </div>
        {jobs.length === 0 ? (
          <Empty>No jobs yet. Define what to back up, where to, and on which schedule.</Empty>
        ) : (
          jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              targets={targets}
              agents={agents}
              channels={channels}
              reload={reload}
            />
          ))
        )}
      </div>
    </div>
  );
}

function JobRow({
  job: j,
  targets,
  agents,
  channels,
  reload,
}: {
  job: Job;
  targets: Target[];
  agents: Agent[];
  channels: NotificationChannel[];
  reload: () => void;
}) {
  const toast = useToast();
  const { open, confirmDialog } = useModal();

  const tgt = targets.find((t) => t.id === j.target_id);
  const agent = agents.find((a) => a.id === j.agent_id);
  const where = j.location === 'agent' ? `Agent: ${agent?.name ?? 'unknown'}` : 'Local';

  return (
    <div className="row">
      <span className={`status-dot ${j.enabled ? 'online' : 'offline'}`} />
      <div className="row-main">
        <div className="row-title">{j.name}</div>
        <div className="row-sub">{`${where} · ${j.paths.join(', ')} → ${tgt?.name ?? '?'} · ${j.cron_expr}`}</div>
      </div>
      <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {j.enabled && j.next_run ? (
          <span>
            next <span style={{ color: 'var(--amber)' }}>{fmtRelative(j.next_run)}</span>
          </span>
        ) : (
          <span className="muted">disabled</span>
        )}
      </div>
      <div className="row-actions">
        <BusyButton
          className="btn btn-primary btn-sm"
          title="Back up now"
          onClick={async () => {
            try {
              await api.post(`/jobs/${j.id}/run`);
              toast('Backup started', 'success');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Start failed', 'error');
            }
          }}
        >
          <Icon name="play" size={15} />
        </BusyButton>
        <button
          className="btn btn-ghost btn-sm"
          title="Edit"
          onClick={() =>
            open((close) => (
              <JobEditor
                targets={targets}
                agents={agents}
                channels={channels}
                job={j}
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
          title="Duplicate"
          onClick={() =>
            open((close) => (
              <JobEditor
                targets={targets}
                agents={agents}
                channels={channels}
                job={j}
                duplicate
                onClose={close}
                onSaved={reload}
              />
            ))
          }
        >
          <Icon name="copy" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title="Delete"
          onClick={() =>
            confirmDialog(
              'Delete job',
              `"${j.name}" will be removed.`,
              async () => {
                await api.del(`/jobs/${j.id}`);
                toast('Job deleted', 'success');
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

/** A titled group of fields in the job editor. */
function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
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

function NumInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input type="number" min="0" value={value} placeholder="—" onChange={(e) => onChange(e.target.value)} />
  );
}

function JobEditor({
  targets,
  agents,
  channels,
  job,
  duplicate = false,
  onClose,
  onSaved,
}: {
  targets: Target[];
  agents: Agent[];
  channels: NotificationChannel[];
  job?: Job;
  duplicate?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  // Duplicate: prefill from an existing job but create a new one (POST).
  const isEdit = !!job && !duplicate;
  const isDuplicate = !!job && duplicate;
  const opts = (job?.restic_options ?? {}) as Record<string, any>;
  const ret = (opts.retention ?? {}) as Record<string, any>;
  const notify = job?.notify ?? {};

  const [name, setName] = useState(isDuplicate ? `Copy of ${job!.name}` : job?.name ?? '');
  const [tags, setTags] = useState<string>((opts.tags ?? []).join(', '));
  const [enabled, setEnabled] = useState(job ? job.enabled : true);

  // Source: where to run (server or a specific agent) + paths + excludes.
  // A single dropdown lists the server plus every agent — no second step.
  const [where, setWhere] = useState<string>(job?.location === 'agent' ? job.agent_id ?? '' : 'local');
  const [paths, setPaths] = useState<string>((job?.paths ?? []).join('\n'));
  const [excludes, setExcludes] = useState<string>((opts.exclude ?? []).join('\n'));

  const [targetId, setTargetId] = useState<string>(job?.target_id ?? targets[0]?.id ?? '');

  // Schedule: a preset dropdown fills the cron field, and a live description
  // makes the raw expression legible.
  const [cron, setCron] = useState<string>(job?.cron_expr ?? '0 3 * * *');
  const matchPreset = (): string => CRON_PRESETS.find((p) => p.value === cron.trim())?.value ?? 'custom';
  const cronDesc = describeCron(cron);

  const [keepLast, setKeepLast] = useState<string>(ret.keepLast != null ? String(ret.keepLast) : '');
  const [keepDaily, setKeepDaily] = useState<string>(ret.keepDaily != null ? String(ret.keepDaily) : '');
  const [keepWeekly, setKeepWeekly] = useState<string>(ret.keepWeekly != null ? String(ret.keepWeekly) : '');
  const [keepMonthly, setKeepMonthly] = useState<string>(ret.keepMonthly != null ? String(ret.keepMonthly) : '');
  const [prune, setPrune] = useState(!!ret.prune);

  // Custom scripts run on the executing host (server or agent) around the backup.
  const [preScript, setPreScript] = useState<string>(opts.preScript ?? '');
  const [postSuccessScript, setPostSuccessScript] = useState<string>(opts.postSuccessScript ?? '');
  const [postFailureScript, setPostFailureScript] = useState<string>(opts.postFailureScript ?? '');

  // Notifications: which channels to alert, and on which outcomes. Sensible
  // defaults for a new job — alert on failure only.
  const [onFailure, setOnFailure] = useState(job ? !!notify.onFailure : true);
  const [onSuccess, setOnSuccess] = useState(job ? !!notify.onSuccess : false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(notify.channelIds ?? []));
  const toggleChannel = (id: string, checked: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = async () => {
    const retention: Record<string, unknown> = {};
    const setNum = (k: string, v: string) => {
      if (v !== '') retention[k] = Number(v);
    };
    setNum('keepLast', keepLast);
    setNum('keepDaily', keepDaily);
    setNum('keepWeekly', keepWeekly);
    setNum('keepMonthly', keepMonthly);
    if (prune) retention.prune = true;

    const resticOptions: Record<string, unknown> = {
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      exclude: excludes.split('\n').map((t) => t.trim()).filter(Boolean),
    };
    if (Object.keys(retention).length) resticOptions.retention = retention;
    if (preScript.trim()) resticOptions.preScript = preScript.trim();
    if (postSuccessScript.trim()) resticOptions.postSuccessScript = postSuccessScript.trim();
    if (postFailureScript.trim()) resticOptions.postFailureScript = postFailureScript.trim();

    const pathList = paths.split('\n').map((p) => p.trim()).filter(Boolean);

    // 'local' means the server; any other value is an agent id.
    const location = where === 'local' ? 'local' : 'agent';
    const agentId = where === 'local' ? undefined : where;

    const notifyPayload = {
      channelIds: channels.filter((c) => selected.has(c.id)).map((c) => c.id),
      onSuccess,
      onFailure,
    };

    try {
      if (isEdit) {
        await api.patch(`/jobs/${job!.id}`, {
          name,
          location,
          agentId,
          paths: pathList,
          cronExpr: cron,
          resticOptions,
          notify: notifyPayload,
          enabled,
        });
      } else {
        const payload: Record<string, unknown> = {
          name,
          location,
          paths: pathList,
          targetId,
          cronExpr: cron,
          resticOptions,
          notify: notifyPayload,
          enabled,
        };
        if (agentId) payload.agentId = agentId;
        await api.post('/jobs', payload);
      }
      toast('Job saved', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={isEdit ? 'Edit job' : isDuplicate ? 'Duplicate job' : 'New job'}
      wide
      confirmLabel={isEdit ? 'Save' : 'Create'}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="modal-form">
        <Section title="General" sub="">
          <Field label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tags" help="Comma-separated labels added to each snapshot">
            <input
              type="text"
              value={tags}
              placeholder="daily, important"
              onChange={(e) => setTags(e.target.value)}
            />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Job enabled
          </label>
        </Section>

        <Section title="Source" sub="what to back up">
          <Field label="Run on" help="The server itself, or a remote agent">
            <select value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="local">Server (this host)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{`${a.name} (${a.status})`}</option>
              ))}
            </select>
          </Field>
          <Field label="Paths" help="One path per line">
            <textarea placeholder={'/home\n/etc\n/var/www'} value={paths} onChange={(e) => setPaths(e.target.value)} />
          </Field>
          <Field label="Excludes" help="One glob or path per line">
            <textarea placeholder={'*.tmp\n/var/cache'} value={excludes} onChange={(e) => setExcludes(e.target.value)} />
          </Field>
        </Section>

        <Section title="Destination" sub="where to store it">
          <Field label="Target">
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </Section>

        <Section title="Schedule" sub="when it runs">
          <Field label="Preset">
            <select
              value={matchPreset()}
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
          </Field>
          <Field label="Cron" help="minute hour day month weekday">
            <input type="text" value={cron} placeholder="0 3 * * *" onChange={(e) => setCron(e.target.value)} />
          </Field>
          <div className={`cron-preview${cronDesc ? '' : ' invalid'}`}>{`→ ${cronDesc ?? 'Custom schedule'}`}</div>
        </Section>

        <Section title="Retention" sub="how long to keep snapshots">
          <div className="field-row">
            <Field label="keep-last">
              <NumInput value={keepLast} onChange={setKeepLast} />
            </Field>
            <Field label="keep-daily">
              <NumInput value={keepDaily} onChange={setKeepDaily} />
            </Field>
          </div>
          <div className="field-row">
            <Field label="keep-weekly">
              <NumInput value={keepWeekly} onChange={setKeepWeekly} />
            </Field>
            <Field label="keep-monthly">
              <NumInput value={keepMonthly} onChange={setKeepMonthly} />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
            Prune after forget (reclaim storage)
          </label>
        </Section>

        <Section title="Scripts" sub="run custom scripts around the backup">
          <Field
            label="Pre-backup script"
            help="Path on the executing host (server or agent), run directly. A non-zero exit aborts the backup."
          >
            <input
              type="text"
              value={preScript}
              placeholder="/opt/amber/pre-backup.sh"
              onChange={(e) => setPreScript(e.target.value)}
            />
          </Field>
          <Field label="On-success script" help="Runs after a successful backup. Receives AMBER_SNAPSHOT_ID.">
            <input
              type="text"
              value={postSuccessScript}
              placeholder="/opt/amber/on-success.sh"
              onChange={(e) => setPostSuccessScript(e.target.value)}
            />
          </Field>
          <Field label="On-failure script" help="Runs after a failed backup or pre-script. Receives AMBER_ERROR.">
            <input
              type="text"
              value={postFailureScript}
              placeholder="/opt/amber/on-failure.sh"
              onChange={(e) => setPostFailureScript(e.target.value)}
            />
          </Field>
        </Section>

        <Section title="Notifications" sub="alert on job result">
          {channels.length === 0 ? (
            <div className="help">No channels configured. An admin can add them under Notifications.</div>
          ) : (
            <>
              <div className="field-row">
                <label className="checkbox">
                  <input type="checkbox" checked={onFailure} onChange={(e) => setOnFailure(e.target.checked)} />
                  On failure
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={onSuccess} onChange={(e) => setOnSuccess(e.target.checked)} />
                  On success
                </label>
              </div>
              <Field label="Channels">
                <div className="channel-picker">
                  {channels.map((c) => (
                    <label key={c.id} className="checkbox">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={(e) => toggleChannel(c.id, e.target.checked)}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </Field>
            </>
          )}
        </Section>
      </div>
    </FormModal>
  );
}
