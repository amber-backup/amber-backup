import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CheckInfo,
  type IntegrityCheckConfig,
  type IntegrityLevel,
  type Job,
  type Run,
} from '../core/api';
import { Icon } from '../core/icons';
import { describeCron } from '../core/cron';
import { fmtDateTime, fmtDuration, fmtRelative, runDurationMs, statusLabel } from '../core/format';
import { useAsync } from '../hooks/useAsync';
import { useToast } from './toast';
import { useModal, FormModal, ModalFrame } from './modal';
import { Field, Spinner } from './primitives';
import { messages, useT } from '../i18n';
import type { IntegrityMessages } from '../i18n/en/integrity';

/** A verdict older than this is flagged as overdue. */
const STALE_AFTER_DAYS = 30;
/** How often the panel refreshes while a check is queued or running. */
const ACTIVE_REFRESH_MS = 3000;
const DEFAULT_SUBSET_PARTS = 12;

const LEVELS: IntegrityLevel[] = ['quick', 'rotating', 'full'];

/** Schedules offered for checks; off-hours so they don't collide with daytime backups. */
const CHECK_PRESETS: { key: keyof IntegrityMessages['presets']; value: string }[] = [
  { key: 'daily', value: '0 4 * * *' },
  { key: 'weekly', value: '0 4 * * 0' },
  { key: 'monthly', value: '0 4 1 * *' },
  { key: 'custom', value: 'custom' },
];

/** Short label for what a check verified, e.g. "Rotating · part 3/12". */
export function checkLevelLabel(info?: Pick<CheckInfo, 'level' | 'part' | 'parts'> | null): string {
  const t = messages().integrity.levelLabel;
  if (!info) return t.check;
  if (info.level === 'full') return t.full;
  if (info.level === 'rotating') {
    return info.part && info.parts ? t.rotatingPart(info.part, info.parts) : t.rotating;
  }
  return t.quick;
}

type Tone = 'success' | 'danger' | 'warn' | 'muted';

/** The repository's integrity state as one badge: tone, label and tooltip. */
export function integrityVerdict(job: Job): { tone: Tone; label: string; title: string } {
  const t = messages().integrity.verdict;
  const at = job.repo_check_at;
  const failedNote = job.repo_check_error ? t.failedNote(job.repo_check_error) : '';
  if (job.repo_check_status === 'damaged') {
    return {
      tone: 'danger',
      label: t.damaged,
      title: `${t.damagedTitle(fmtDateTime(at))}${failedNote}`,
    };
  }
  if (job.repo_check_status === 'passed' && at) {
    const ageDays = (Date.now() - new Date(at).getTime()) / 86_400_000;
    return {
      tone: ageDays > STALE_AFTER_DAYS ? 'warn' : 'success',
      label: t.verified(fmtRelative(at)),
      title: `${t.passedTitle(fmtDateTime(at), checkLevelLabel({ level: job.repo_check_level ?? 'quick' }))}${failedNote}`,
    };
  }
  return {
    tone: job.repo_check_error ? 'danger' : 'muted',
    label: job.repo_check_error ? t.checkFailed : t.notVerified,
    title: job.repo_check_error ? t.checkFailedTitle(job.repo_check_error) : t.neverCheckedTitle,
  };
}

export function IntegrityBadge({ job }: { job: Job }) {
  const v = integrityVerdict(job);
  return (
    <span className={`badge ${v.tone} integrity-badge`} title={v.title}>
      {v.label}
    </span>
  );
}

/** restic errors span several lines; the last one ("Fatal: …") says the most. */
function errorSummary(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? message;
}

function isActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * Integrity state of a job's repository: the verdict, how much data has been
 * read back, the schedule, and the recent checks — with actions to start a
 * check and edit the schedule. `onChanged` reloads the job once a check
 * finishes or the schedule is saved, so the verdict here stays current.
 */
export function IntegrityPanel({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const t = useT();
  const { open } = useModal();
  const runs = useAsync(() => api.get<Run[]>(`/runs?jobId=${job.id}&kind=check&limit=5`), [job.id]);
  const active = runs.data?.some((r) => isActive(r.status)) ?? false;

  // Refresh while a check is in flight; once it settles, reload the job so the
  // repository verdict reflects it.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) onChanged();
    wasActive.current = active;
    if (!active) return;
    const timer = setInterval(runs.reload, ACTIVE_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const openCheck = () =>
    open((close) => <CheckDialog job={job} onClose={close} onStarted={runs.reload} />);
  const openSchedule = () =>
    open((close) => <ScheduleDialog job={job} onClose={close} onSaved={onChanged} />);

  const config = job.integrity_check ?? {};

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="integrity-head">
          <h2>{t.integrity.panel.title}</h2>
          <IntegrityBadge job={job} />
        </div>
        <div className="panel-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={openSchedule}>
            <Icon name="clock" size={14} />
            {t.integrity.panel.schedule}
          </button>
          <button className="btn btn-primary btn-sm" onClick={openCheck} disabled={active}>
            <Icon name="shield" size={14} />
            {active ? t.integrity.panel.checkRunning : t.integrity.panel.checkNow}
          </button>
        </div>
      </div>

      {job.repo_check_status === 'damaged' && (
        <div className="integrity-alert warn-box">
          {t.integrity.panel.damagedAlert(fmtDateTime(job.repo_check_at))}
        </div>
      )}

      <div className="integrity-facts">
        <Fact
          label={t.integrity.panel.lastVerdict}
          value={verdictText(job, t.integrity)}
          sub={
            job.repo_check_at
              ? `${fmtDateTime(job.repo_check_at)} · ${checkLevelLabel({ level: job.repo_check_level ?? 'quick' })}`
              : t.integrity.panel.startCheckHint
          }
        />
        <DataFact job={job} />
        <Fact
          label={t.integrity.panel.schedule}
          value={
            config.enabled && config.cronExpr
              ? (describeCron(config.cronExpr) ?? config.cronExpr)
              : t.integrity.panel.notScheduled
          }
          sub={
            config.enabled && config.cronExpr
              ? `${checkLevelLabel({ level: config.level ?? 'quick' })}${
                  job.next_check
                    ? t.integrity.panel.next(fmtRelative(job.next_check))
                    : job.enabled
                      ? ''
                      : t.integrity.panel.jobDisabled
                }`
              : t.integrity.panel.manualOnly
          }
        />
      </div>

      {job.repo_check_error && (
        <div className="integrity-note" title={job.repo_check_error}>
          {t.integrity.panel.lastAttemptFailed(errorSummary(job.repo_check_error))}
        </div>
      )}

      <div className="integrity-runs">
        <div className="integrity-runs-head">{t.integrity.panel.recentChecks}</div>
        {!runs.data ? (
          runs.error ? (
            <div className="empty">{runs.error.message}</div>
          ) : (
            <div className="loading">
              <Spinner />
            </div>
          )
        ) : runs.data.length === 0 ? (
          <div className="empty">{t.integrity.panel.noChecks}</div>
        ) : (
          runs.data.map((r) => <CheckRunRow key={r.id} run={r} onChanged={runs.reload} />)
        )}
      </div>
    </div>
  );
}

function verdictText(job: Job, t: IntegrityMessages): string {
  if (job.repo_check_status === 'passed') return t.panel.noErrorsFound;
  if (job.repo_check_status === 'damaged') return t.panel.integrityErrorsFound;
  return t.panel.neverChecked;
}

function Fact({ label, value, sub, children }: { label: string; value: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="integrity-fact">
      <div className="integrity-fact-label">{label}</div>
      <div className="integrity-fact-value">{value}</div>
      {children}
      {sub && <div className="integrity-fact-sub">{sub}</div>}
    </div>
  );
}

/** When all data was last read back, plus the progress of a rotation in flight. */
function DataFact({ job }: { job: Job }) {
  const t = useT().integrity.data;
  const schedParts = job.integrity_check?.level === 'rotating' ? (job.integrity_check.subsetParts ?? DEFAULT_SUBSET_PARTS) : null;
  const parts = schedParts ?? job.repo_check_subset_parts ?? null;
  // Parts of the current rotation already read: only meaningful when the
  // stored rotation uses the same split as the schedule.
  const sameSplit = parts != null && job.repo_check_subset_parts === parts;
  const done = sameSplit ? Math.max(0, (job.repo_check_subset_next ?? 1) - 1) : 0;
  // Back at part 1 after passing the last part: the rotation just completed.
  const completed = sameSplit && done === 0 && job.repo_data_verified_at != null;
  const shown = completed ? parts : done;

  return (
    <Fact
      label={t.label}
      value={job.repo_data_verified_at ? fmtRelative(job.repo_data_verified_at) : t.never}
      sub={
        parts
          ? completed
            ? t.rotationComplete(parts)
            : t.rotationProgress(done, parts)
          : job.repo_data_verified_at
            ? fmtDateTime(job.repo_data_verified_at)
            : t.readBackHint
      }
    >
      {parts ? (
        <div className="progress-track integrity-rotation" title={t.partsTitle(shown ?? 0, parts)}>
          <div className="fill" style={{ width: `${Math.round((shown / parts) * 100)}%` }} />
        </div>
      ) : null}
    </Fact>
  );
}

function CheckRunRow({ run: r, onChanged }: { run: Run; onChanged: () => void }) {
  const { integrity, common } = useT();
  const t = integrity.run;
  const toast = useToast();
  const { open } = useModal();
  const damaged = r.check_info?.damaged === true;

  const cancel = async () => {
    try {
      await api.post(`/runs/${r.id}/cancel`);
      toast(t.cancelled, 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t.cancelFailed, 'error');
    }
  };

  const sub =
    r.status === 'success'
      ? t.noErrorsFound
      : damaged
        ? t.integrityErrorsFound
        : r.status === 'failed' && r.error
          ? errorSummary(r.error)
          : statusLabel(r.status);

  return (
    <div className="row compact">
      <span className={`status-dot ${damaged ? 'failed' : r.status}`} />
      <div className="row-main">
        <div className="row-title">
          {checkLevelLabel(r.check_info)}
          {r.trigger === 'schedule' && <span className="badge muted row-kind">{t.scheduled}</span>}
        </div>
        <div className="row-sub integrity-run-sub" title={r.error ?? undefined}>
          {sub}
        </div>
      </div>
      <div className="row-meta run-meta">
        <span>
          {damaged ? (
            <span className="badge danger">{t.damaged}</span>
          ) : r.status !== 'success' ? (
            <span className={`badge ${r.status === 'failed' ? 'danger' : r.status === 'queued' ? 'info' : 'muted'}`}>
              {statusLabel(r.status)}
            </span>
          ) : (
            <span className="badge success">{t.passed}</span>
          )}
        </span>
        <span className="muted" title={t.duration}>
          {r.started_at ? fmtDuration(runDurationMs(r)) : ''}
        </span>
        <span className="muted">{fmtRelative(r.finished_at ?? r.created_at)}</span>
      </div>
      <div className="row-actions">
        {isActive(r.status) ? (
          <button className="btn btn-ghost btn-sm" onClick={() => void cancel()}>
            <Icon name="x" size={14} />
            {common.cancel}
          </button>
        ) : (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => open((close) => <RunLogModal runId={r.id} title={checkLevelLabel(r.check_info)} onClose={close} />)}
          >
            <Icon name="file" size={14} />
            {t.log}
          </button>
        )}
      </div>
    </div>
  );
}

function RunLogModal({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }) {
  const t = useT().integrity.run;
  const { data, loading, error } = useAsync(() => api.get<Run & { log?: string | null }>(`/runs/${runId}`), [runId]);
  return (
    <ModalFrame title={t.logTitle(title)} wide onClose={onClose}>
      {loading ? (
        <div className="loading">
          <Spinner />
        </div>
      ) : error ? (
        <div className="empty">{error.message}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data?.error && <div className="warn-box">{data.error}</div>}
          <pre className="run-log">{data?.log?.trim() || t.noOutput}</pre>
        </div>
      )}
    </ModalFrame>
  );
}

function LevelOptions({
  value,
  onChange,
  job,
  parts,
}: {
  value: IntegrityLevel;
  onChange: (v: IntegrityLevel) => void;
  job: Job;
  parts: number;
}) {
  const t = useT().integrity.levels;
  return (
    <div className="level-options" role="radiogroup">
      {LEVELS.map((level) => {
        let desc = t[level].desc;
        if (level === 'rotating') {
          const next =
            job.repo_check_subset_parts === parts ? (job.repo_check_subset_next ?? 1) : 1;
          desc = `${desc} ${t.nextPart(next, parts)}`;
        }
        return (
          <label key={level} className={`level-option${value === level ? ' selected' : ''}`}>
            <input
              type="radio"
              name="integrity-level"
              checked={value === level}
              onChange={() => onChange(level)}
            />
            <span>
              <span className="level-option-title">{t[level].title}</span>
              <span className="level-option-desc">{desc}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function CheckDialog({ job, onClose, onStarted }: { job: Job; onClose: () => void; onStarted: () => void }) {
  const t = useT().integrity.checkDialog;
  const toast = useToast();
  const config = job.integrity_check ?? {};
  const [level, setLevel] = useState<IntegrityLevel>(config.level ?? 'quick');
  const parts = config.subsetParts ?? DEFAULT_SUBSET_PARTS;

  const submit = async () => {
    try {
      await api.post(`/jobs/${job.id}/check`, { level });
      toast(t.started, 'success');
      onStarted();
    } catch (err) {
      toast(err instanceof Error ? err.message : t.startFailed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.title(job.name)} confirmLabel={t.start} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <LevelOptions value={level} onChange={setLevel} job={job} parts={parts} />
        {level === 'full' && job.target_id != null && (
          <div className="warn-box">{t.fullWarning}</div>
        )}
        <span className="muted" style={{ fontSize: 12.5 }}>
          {job.location === 'agent' ? t.lockAgent : t.lockLocal}
        </span>
      </div>
    </FormModal>
  );
}

function ScheduleDialog({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: () => void }) {
  const { integrity } = useT();
  const t = integrity.scheduleDialog;
  const toast = useToast();
  const initial: IntegrityCheckConfig = job.integrity_check ?? {};
  const [enabled, setEnabled] = useState(initial.enabled ?? false);
  const [cron, setCron] = useState(initial.cronExpr ?? '0 4 * * 0');
  const [level, setLevel] = useState<IntegrityLevel>(initial.level ?? 'rotating');
  const [parts, setParts] = useState(String(initial.subsetParts ?? DEFAULT_SUBSET_PARTS));
  const preset = CHECK_PRESETS.find((p) => p.value === cron.trim())?.value ?? 'custom';
  const cronDesc = describeCron(cron);
  const partsNum = Number(parts);
  const partsValid = Number.isInteger(partsNum) && partsNum >= 2 && partsNum <= 100;

  const submit = async () => {
    if (level === 'rotating' && !partsValid) {
      toast(t.partsInvalid, 'error');
      return false;
    }
    try {
      await api.put(`/jobs/${job.id}/integrity-check`, {
        enabled,
        cronExpr: cron.trim(),
        level,
        subsetParts: level === 'rotating' ? partsNum : undefined,
      });
      toast(t.saved, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : t.saveFailed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.title(job.name)} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t.enable}
        </label>
        <div className="field-row">
          <Field label={t.preset}>
            <select
              value={preset}
              disabled={!enabled}
              onChange={(e) => {
                if (e.target.value !== 'custom') setCron(e.target.value);
              }}
            >
              {CHECK_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {integrity.presets[p.key]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.cron} help={t.cronHelp}>
            <input
              type="text"
              value={cron}
              disabled={!enabled}
              placeholder="0 4 * * 0"
              onChange={(e) => setCron(e.target.value)}
            />
          </Field>
        </div>
        {enabled && (
          <div className={`cron-preview${cronDesc ? '' : ' invalid'}`}>{`→ ${cronDesc ?? t.customSchedule}`}</div>
        )}
        <LevelOptions value={level} onChange={setLevel} job={job} parts={partsValid ? partsNum : DEFAULT_SUBSET_PARTS} />
        {level === 'rotating' && (
          <Field
            label={t.parts}
            help={partsValid ? t.partsHelp(partsNum) : t.partsRange}
          >
            <input type="number" min="2" max="100" value={parts} onChange={(e) => setParts(e.target.value)} />
          </Field>
        )}
        <span className="muted" style={{ fontSize: 12.5 }}>
          {t.lockNote}
        </span>
      </div>
    </FormModal>
  );
}
