import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type Job,
  type Target,
  type Agent,
  type NotificationChannel,
  type BackendDef,
  type RepositoryStats,
} from '../core/api';
import { Icon } from '../core/icons';
import { fmtBytes, fmtDateTime, fmtDuration, fmtRelative } from '../core/format';
import { describeCron } from '../core/cron';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty, BusyButton } from '../ui/primitives';
import { BackendFields } from '../ui/backend-fields';
import { useT } from '../i18n';
import type { Messages } from '../i18n/en';

/** Sentinel target value for a local-filesystem repository (no connection). */
const LOCAL_REPO = '__local__';

export function Jobs() {
  const { data, loading, reload } = useAsync(() =>
    Promise.all([
      api.get<Job[]>('/jobs'),
      api.get<Target[]>('/targets'),
      api.get<Agent[]>('/agents').catch(() => [] as Agent[]),
      // Channels are admin-only; non-admins simply get an empty list.
      api.get<NotificationChannel[]>('/notification-channels').catch(() => [] as NotificationChannel[]),
      api.get<BackendDef[]>('/targets/backends'),
    ]),
  );
  const { open } = useModal();
  const t = useT();

  if (loading || !data) return <Loading label={t.common.loading} />;
  const [jobs, targets, agents, channels, backends] = data;

  const newJob = () =>
    open((close) => (
      <JobEditor
        targets={targets}
        agents={agents}
        channels={channels}
        backends={backends}
        onClose={close}
        onSaved={reload}
      />
    ));

  return (
    <div>
      <PageHeader
        title={t.jobs.title}
        subtitle={t.jobs.subtitle(jobs.length)}
        actions={<ActionButton label={t.jobs.newJob} icon="plus" variant="primary" onClick={newJob} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{t.jobs.panelTitle}</h2>
        </div>
        {jobs.length === 0 ? (
          <Empty>{t.jobs.empty}</Empty>
        ) : (
          jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              targets={targets}
              agents={agents}
              channels={channels}
              backends={backends}
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
  backends,
  reload,
}: {
  job: Job;
  targets: Target[];
  agents: Agent[];
  channels: NotificationChannel[];
  backends: BackendDef[];
  reload: () => void;
}) {
  const toast = useToast();
  const { open, confirmDialog } = useModal();
  const t = useT();
  const m = t.jobs.row;

  const tgt = targets.find((x) => x.id === j.target_id);
  const agent = agents.find((a) => a.id === j.agent_id);
  const agentName = j.location === 'agent' ? (agent?.name ?? m.unknownAgent) : m.server;
  // A null target is a local-filesystem repository.
  const targetName = j.target_id ? (tgt?.name ?? '?') : m.localFilesystem;
  // The repository is identified by the job-scoped fields (bucket, prefix, path…),
  // joined in the order the backend declares them.
  const repoConfig = j.repo_config ?? {};
  const repoFieldNames = j.target_id
    ? (backends.find((b) => b.type === tgt?.backend_type)?.fields ?? [])
        .filter((f) => f.scope === 'job')
        .map((f) => f.name)
    : ['path'];
  const repoName =
    repoFieldNames
      .map((n) => repoConfig[n])
      .filter((v) => v != null && v !== '')
      .map(String)
      .join('/') || '—';

  return (
    <div className="row">
      <span className={`status-dot ${j.enabled ? 'online' : 'offline'}`} />
      <div className="row-main">
        <div className="row-title">{j.name}</div>
        <div className="row-sub">
          {m.agent} <span style={{ color: 'var(--amber)' }}>{agentName}</span>
          {' · '}{m.target} <span style={{ color: 'var(--amber)' }}>{targetName}</span>
          {' · '}{m.repository} <span style={{ color: 'var(--amber)' }}>{repoName}</span>
        </div>
      </div>
      <div className="row-meta" style={{ fontSize: 12, color: 'var(--text-2)' }}>
        {j.enabled && j.next_run ? (
          <span>
            {m.next} <span style={{ color: 'var(--amber)' }}>{fmtRelative(j.next_run)}</span>
          </span>
        ) : (
          <span className="muted">{m.disabled}</span>
        )}
        <RepoSize job={j} />
      </div>
      <div className="row-actions">
        <BusyButton
          className="btn btn-primary btn-sm"
          title={m.backUpNow}
          onClick={async () => {
            try {
              await api.post(`/jobs/${j.id}/run`);
              toast(m.backupStarted, 'success');
            } catch (err) {
              toast(err instanceof Error ? err.message : m.startFailed, 'error');
            }
          }}
        >
          <Icon name="play" size={15} />
        </BusyButton>
        <button
          className="btn btn-ghost btn-sm"
          title={m.edit}
          onClick={() =>
            open((close) => (
              <JobEditor
                targets={targets}
                agents={agents}
                channels={channels}
                backends={backends}
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
          title={m.duplicate}
          onClick={() =>
            open((close) => (
              <JobEditor
                targets={targets}
                agents={agents}
                channels={channels}
                backends={backends}
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
          title={t.common.delete}
          onClick={() =>
            confirmDialog(
              m.deleteTitle,
              m.deleteConfirm(j.name),
              async () => {
                await api.del(`/jobs/${j.id}`);
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

/**
 * Cached repository size and snapshot count with a refresh action. Figures are
 * read by the server after each successful run; the button re-reads them now.
 */
function RepoSize({ job }: { job: Job }) {
  const toast = useToast();
  const [stats, setStats] = useState<RepositoryStats>({
    size_bytes: job.repo_size_bytes ?? null,
    snapshot_count: job.repo_snapshot_count ?? null,
    stats_at: job.repo_stats_at ?? null,
    stats_error: job.repo_stats_error ?? null,
  });
  const m = useT().jobs.repoSize;

  const title = stats.stats_error
    ? m.statsError(stats.stats_error)
    : stats.stats_at
      ? m.asOf(fmtDateTime(stats.stats_at))
      : m.notRead;

  return (
    <div className="repo-size" title={title}>
      <span className={stats.stats_error ? 'repo-size-stale' : undefined}>
        {stats.size_bytes == null ? (
          m.unknown
        ) : (
          <>
            {fmtBytes(stats.size_bytes)}
            {' · '}
            <Link to={`/snapshots/${job.slug}`} className="repo-size-link" title={m.openSnapshots}>
              {m.snapshots(stats.snapshot_count ?? null)}
            </Link>
          </>
        )}
      </span>
      <BusyButton
        className="btn btn-ghost"
        title={m.refresh}
        onClick={async () => {
          try {
            const fresh = await api.post<RepositoryStats>(`/repositories/${job.repository_id}/stats`);
            setStats(fresh);
            if (fresh.stats_error) toast(m.refreshError(fresh.stats_error), 'error');
          } catch (err) {
            toast(err instanceof Error ? err.message : m.refreshFailed, 'error');
          }
        }}
      >
        <Icon name="refresh" size={12} />
      </BusyButton>
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
const cronPresets = (t: Messages): { label: string; value: string }[] => [
  { label: t.jobs.presets.hourly, value: '0 * * * *' },
  { label: t.jobs.presets.every6Hours, value: '0 */6 * * *' },
  { label: t.jobs.presets.daily, value: '0 3 * * *' },
  { label: t.jobs.presets.weekly, value: '0 3 * * 0' },
  { label: t.jobs.presets.monthly, value: '0 3 1 * *' },
  { label: t.jobs.presets.custom, value: 'custom' },
];

function NumInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input type="number" min="0" value={value} placeholder="—" onChange={(e) => onChange(e.target.value)} />
  );
}

function JobEditor({
  targets,
  agents,
  channels,
  backends,
  job,
  duplicate = false,
  onClose,
  onSaved,
}: {
  targets: Target[];
  agents: Agent[];
  channels: NotificationChannel[];
  backends: BackendDef[];
  job?: Job;
  duplicate?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const m = t.jobs.editor;
  const presets = cronPresets(t);
  // Duplicate: prefill from an existing job but create a new one (POST).
  const isEdit = !!job && !duplicate;
  const isDuplicate = !!job && duplicate;
  const opts = (job?.restic_options ?? {}) as Record<string, any>;
  const ret = (opts.retention ?? {}) as Record<string, any>;
  const notify = job?.notify ?? {};

  const [name, setName] = useState(isDuplicate ? m.copyOf(job!.name) : job?.name ?? '');
  const [tags, setTags] = useState<string>((opts.tags ?? []).join(', '));
  const [enabled, setEnabled] = useState(job ? job.enabled : true);

  // Source: where to run (server or a specific agent) + paths + excludes.
  // A single dropdown lists the server plus every agent — no second step.
  const [where, setWhere] = useState<string>(job?.location === 'agent' ? job.agent_id ?? '' : 'local');
  const [paths, setPaths] = useState<string>((job?.paths ?? []).join('\n'));
  const [excludes, setExcludes] = useState<string>((opts.exclude ?? []).join('\n'));

  // Repository: a connection (target) plus the repo-specific fields
  // (bucket/prefix/path), or the local filesystem (LOCAL_REPO ⇒ target_id null).
  const initialTarget =
    job !== undefined
      ? (job.target_id ?? LOCAL_REPO)
      : (targets[0]?.id ?? LOCAL_REPO);
  const [targetId, setTargetId] = useState<string>(initialTarget);
  const [repoValues, setRepoValues] = useState<Record<string, string>>(() => {
    const cfg = job?.repo_config ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg)) out[k] = v != null ? String(v) : '';
    return out;
  });
  const [repoPassword, setRepoPassword] = useState('');
  // Some connections (a REST server with per-repository accounts) allow a job to
  // authenticate with its own credentials. Duplicating a job cannot carry the
  // secrets over, so only a real edit starts with the box ticked.
  const [overrideCreds, setOverrideCreds] = useState(
    isEdit && !!job?.has_credential_override,
  );
  const [credValues, setCredValues] = useState<Record<string, string>>({});

  // The local filesystem is a job-level repository option, NOT a target/backend:
  // it never comes from the connection catalog. For a real connection, the
  // repo-specific fields (bucket/prefix/path) come from its backend's job-scoped
  // fields; for local, the only field is a plain path (rendered directly below).
  const isLocalRepo = targetId === LOCAL_REPO;
  const selectedBackendType = targets.find((t) => t.id === targetId)?.backend_type;
  const repoBackend = backends.find((b) => b.type === selectedBackendType);
  const repoFields = repoBackend?.fields.filter((f) => f.scope === 'job') ?? [];
  // Connection credentials this backend lets a single job override. On an edit
  // the stored values are never returned, so the inputs stay empty and only
  // what is typed here is sent.
  const credFields = (repoBackend?.fields.filter((f) => f.overridable) ?? []).map((f) =>
    isEdit && job?.has_credential_override
      ? { ...f, placeholder: m.leaveUnchanged }
      : f,
  );
  const setRepoValue = (n: string, v: string) =>
    setRepoValues((cur) => ({ ...cur, [n]: v }));
  const setCredValue = (n: string, v: string) =>
    setCredValues((cur) => ({ ...cur, [n]: v }));
  // Switching the connection changes which repo fields apply — start fresh. The
  // credential override belongs to the old connection, so it goes too.
  const changeTarget = (id: string) => {
    setTargetId(id);
    setRepoValues({});
    setOverrideCreds(false);
    setCredValues({});
  };
  // A local filesystem repository is, for now, only allowed when the job runs on
  // the server (not on an agent).
  const localRepoAllowed = where === 'local';
  const changeWhere = (w: string) => {
    setWhere(w);
    // Leaving the server for an agent invalidates a local repo — reset it.
    if (w !== 'local' && targetId === LOCAL_REPO) changeTarget(targets[0]?.id ?? '');
  };

  // Schedule: a preset dropdown fills the cron field, and a live description
  // makes the raw expression legible.
  const [cron, setCron] = useState<string>(job?.cron_expr ?? '0 3 * * *');
  const matchPreset = (): string => presets.find((p) => p.value === cron.trim())?.value ?? 'custom';
  const cronDesc = describeCron(cron);

  // Retries of a failed backup: how many, and how long to wait before each.
  const [retryMax, setRetryMax] = useState<string>(String(job?.retry_max ?? 0));
  const [retryDelay, setRetryDelay] = useState<string>(String(job?.retry_delay_seconds ?? 300));
  const retryCount = Math.max(0, Math.floor(Number(retryMax) || 0));

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
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      exclude: excludes.split('\n').map((s) => s.trim()).filter(Boolean),
    };
    if (Object.keys(retention).length) resticOptions.retention = retention;
    if (preScript.trim()) resticOptions.preScript = preScript.trim();
    if (postSuccessScript.trim()) resticOptions.postSuccessScript = postSuccessScript.trim();
    if (postFailureScript.trim()) resticOptions.postFailureScript = postFailureScript.trim();

    const pathList = paths.split('\n').map((p) => p.trim()).filter(Boolean);

    // 'local' means the server; any other value is an agent id.
    const location = where === 'local' ? 'local' : 'agent';
    const agentId = where === 'local' ? undefined : where;

    // Repository: a local filesystem path (target_id null) or a connection plus
    // its job-scoped fields.
    const targetIdPayload = isLocalRepo ? null : targetId;
    const repoConfig: Record<string, unknown> = {};
    if (isLocalRepo) {
      if (repoValues.path) repoConfig.path = repoValues.path;
    } else {
      for (const f of repoFields) {
        const v = repoValues[f.name];
        if (v != null && v !== '') repoConfig[f.name] = v;
      }
    }

    // Credential override: undefined leaves the stored one untouched, null
    // removes it, an object merges the entered fields into it.
    let repoCredentials: Record<string, string> | null | undefined;
    if (!isLocalRepo && credFields.length > 0) {
      if (overrideCreds) {
        const entered: Record<string, string> = {};
        for (const f of credFields) {
          const v = credValues[f.name];
          if (v != null && v !== '') entered[f.name] = v;
        }
        if (Object.keys(entered).length > 0) repoCredentials = entered;
      } else if (isEdit && job?.has_credential_override) {
        repoCredentials = null;
      }
    }

    const retryPayload = {
      retryMax: retryCount,
      retryDelaySeconds: Math.floor(Number(retryDelay) || 0),
    };

    const notifyPayload = {
      channelIds: channels.filter((c) => selected.has(c.id)).map((c) => c.id),
      onSuccess,
      onFailure,
    };

    try {
      if (isEdit) {
        const patch: Record<string, unknown> = {
          name,
          location,
          agentId,
          paths: pathList,
          targetId: targetIdPayload,
          repoConfig,
          cronExpr: cron,
          resticOptions,
          notify: notifyPayload,
          ...retryPayload,
          enabled,
        };
        // Secrets are never returned: only send a new repo password if set.
        if (repoPassword) patch.repoPassword = repoPassword;
        if (repoCredentials !== undefined) patch.repoCredentials = repoCredentials;
        await api.patch(`/jobs/${job!.id}`, patch);
      } else {
        const payload: Record<string, unknown> = {
          name,
          location,
          paths: pathList,
          targetId: targetIdPayload,
          repoConfig,
          repoPassword,
          cronExpr: cron,
          resticOptions,
          notify: notifyPayload,
          ...retryPayload,
          enabled,
        };
        if (agentId) payload.agentId = agentId;
        if (repoCredentials) payload.repoCredentials = repoCredentials;
        await api.post('/jobs', payload);
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
      title={isEdit ? m.titleEdit : isDuplicate ? m.titleDuplicate : m.titleNew}
      wide
      confirmLabel={isEdit ? t.common.save : m.create}
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="modal-form">
        <Section title={m.general.title} sub="">
          <Field label={m.general.name}>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={m.general.tags} help={m.general.tagsHelp}>
            <input
              type="text"
              value={tags}
              placeholder={m.general.tagsPlaceholder}
              onChange={(e) => setTags(e.target.value)}
            />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {m.general.enabled}
          </label>
        </Section>

        <Section title={m.source.title} sub={m.source.sub}>
          <Field label={m.source.runOn} help={m.source.runOnHelp}>
            <select value={where} onChange={(e) => changeWhere(e.target.value)}>
              <option value="local">{m.source.serverOption}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{`${a.name} (${t.common.status[a.status] ?? a.status})`}</option>
              ))}
            </select>
          </Field>
          <Field label={m.source.paths} help={m.source.pathsHelp}>
            <textarea placeholder={'/home\n/etc\n/var/www'} value={paths} onChange={(e) => setPaths(e.target.value)} />
          </Field>
          <Field label={m.source.excludes} help={m.source.excludesHelp}>
            <textarea placeholder={'*.tmp\n/var/cache'} value={excludes} onChange={(e) => setExcludes(e.target.value)} />
          </Field>
        </Section>

        <Section title={m.repository.title} sub={m.repository.sub}>
          <Field
            label={m.repository.target}
            help={localRepoAllowed ? m.repository.targetHelpLocal : m.repository.targetHelpAgent}
          >
            <select value={targetId} onChange={(e) => changeTarget(e.target.value)}>
              {localRepoAllowed && <option value={LOCAL_REPO}>{m.repository.localFilesystem}</option>}
              {targets.map((tg) => (
                <option key={tg.id} value={tg.id}>
                  {tg.name}
                </option>
              ))}
            </select>
          </Field>
          {isLocalRepo ? (
            <Field label={m.repository.path} help={m.repository.pathHelp}>
              <input
                type="text"
                placeholder="/srv/restic-repo"
                value={repoValues.path ?? ''}
                onChange={(e) => setRepoValue('path', e.target.value)}
              />
            </Field>
          ) : (
            <BackendFields fields={repoFields} values={repoValues} onChange={setRepoValue} />
          )}
          {!isLocalRepo && credFields.length > 0 && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={overrideCreds}
                  onChange={(e) => {
                    setOverrideCreds(e.target.checked);
                    if (!e.target.checked) setCredValues({});
                  }}
                />
                {m.repository.overrideCredentials}
              </label>
              {overrideCreds && (
                <BackendFields
                  fields={credFields}
                  values={credValues}
                  onChange={setCredValue}
                />
              )}
            </>
          )}
          <Field label={isEdit ? m.repository.changePassword : m.repository.password}>
            <input
              type="password"
              placeholder={isEdit ? m.leaveUnchanged : m.repository.password}
              value={repoPassword}
              onChange={(e) => setRepoPassword(e.target.value)}
            />
          </Field>
        </Section>

        <Section title={m.schedule.title} sub={m.schedule.sub}>
          <Field label={m.schedule.preset}>
            <select
              value={matchPreset()}
              onChange={(e) => {
                if (e.target.value !== 'custom') setCron(e.target.value);
              }}
            >
              {presets.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={m.schedule.cron} help={m.schedule.cronHelp}>
            <input type="text" value={cron} placeholder="0 3 * * *" onChange={(e) => setCron(e.target.value)} />
          </Field>
          <div className={`cron-preview${cronDesc ? '' : ' invalid'}`}>{`→ ${cronDesc ?? m.schedule.custom}`}</div>
        </Section>

        <Section title={m.retries.title} sub={m.retries.sub}>
          <div className="field-row">
            <Field label={m.retries.max} help={m.retries.maxHelp}>
              <input type="number" min="0" max="10" value={retryMax} onChange={(e) => setRetryMax(e.target.value)} />
            </Field>
            <Field label={m.retries.delay} help={m.retries.delayHelp}>
              <input
                type="number"
                min="10"
                max="86400"
                value={retryDelay}
                disabled={retryCount === 0}
                onChange={(e) => setRetryDelay(e.target.value)}
              />
            </Field>
          </div>
          <div className="cron-preview">{m.retries.summary(retryCount, fmtDuration(Number(retryDelay) * 1000))}</div>
        </Section>

        <Section title={m.retention.title} sub={m.retention.sub}>
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
            {m.retention.prune}
          </label>
        </Section>

        <Section title={m.scripts.title} sub={m.scripts.sub}>
          <Field
            label={m.scripts.pre}
            help={m.scripts.preHelp}
          >
            <input
              type="text"
              value={preScript}
              placeholder="/opt/amber/pre-backup.sh"
              onChange={(e) => setPreScript(e.target.value)}
            />
          </Field>
          <Field label={m.scripts.onSuccess} help={m.scripts.onSuccessHelp}>
            <input
              type="text"
              value={postSuccessScript}
              placeholder="/opt/amber/on-success.sh"
              onChange={(e) => setPostSuccessScript(e.target.value)}
            />
          </Field>
          <Field label={m.scripts.onFailure} help={m.scripts.onFailureHelp}>
            <input
              type="text"
              value={postFailureScript}
              placeholder="/opt/amber/on-failure.sh"
              onChange={(e) => setPostFailureScript(e.target.value)}
            />
          </Field>
        </Section>

        <Section title={m.notifications.title} sub={m.notifications.sub}>
          {channels.length === 0 ? (
            <div className="help">{m.notifications.noChannels}</div>
          ) : (
            <>
              <div className="field-row">
                <label className="checkbox">
                  <input type="checkbox" checked={onFailure} onChange={(e) => setOnFailure(e.target.checked)} />
                  {m.notifications.onFailure}
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={onSuccess} onChange={(e) => setOnSuccess(e.target.checked)} />
                  {m.notifications.onSuccess}
                </label>
              </div>
              <Field label={m.notifications.channels}>
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
