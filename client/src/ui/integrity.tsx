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

/** A verdict older than this is flagged as overdue. */
const STALE_AFTER_DAYS = 30;
/** How often the panel refreshes while a check is queued or running. */
const ACTIVE_REFRESH_MS = 3000;
const DEFAULT_SUBSET_PARTS = 12;

const LEVELS: { value: IntegrityLevel; title: string; desc: string }[] = [
  {
    value: 'quick',
    title: 'Structure only',
    desc: 'Verifies snapshots, trees and the index. Fast — reads no file data.',
  },
  {
    value: 'rotating',
    title: 'Rotating data part',
    desc: 'Also downloads and verifies one part of the data. Each run continues with the next part, so over time all data is read back.',
  },
  {
    value: 'full',
    title: 'All data',
    desc: 'Downloads and verifies every data pack. Slow, and on cloud storage it can cause significant egress costs.',
  },
];

/** Schedules offered for checks; off-hours so they don't collide with daytime backups. */
const CHECK_PRESETS: { label: string; value: string }[] = [
  { label: 'Daily at 04:00', value: '0 4 * * *' },
  { label: 'Weekly — Sunday 04:00', value: '0 4 * * 0' },
  { label: 'Monthly — 1st, 04:00', value: '0 4 1 * *' },
  { label: 'Custom…', value: 'custom' },
];

/** Short label for what a check verified, e.g. "Rotating · part 3/12". */
export function checkLevelLabel(info?: Pick<CheckInfo, 'level' | 'part' | 'parts'> | null): string {
  if (!info) return 'Check';
  if (info.level === 'full') return 'Full · all data';
  if (info.level === 'rotating') {
    return info.part && info.parts ? `Rotating · part ${info.part}/${info.parts}` : 'Rotating';
  }
  return 'Quick · structure';
}

type Tone = 'success' | 'danger' | 'warn' | 'muted';

/** The repository's integrity state as one badge: tone, label and tooltip. */
export function integrityVerdict(job: Job): { tone: Tone; label: string; title: string } {
  const at = job.repo_check_at;
  const failedNote = job.repo_check_error ? ` — the last attempt could not finish: ${job.repo_check_error}` : '';
  if (job.repo_check_status === 'damaged') {
    return {
      tone: 'danger',
      label: 'Damaged',
      title: `restic found integrity errors on ${fmtDateTime(at)}${failedNote}`,
    };
  }
  if (job.repo_check_status === 'passed' && at) {
    const ageDays = (Date.now() - new Date(at).getTime()) / 86_400_000;
    return {
      tone: ageDays > STALE_AFTER_DAYS ? 'warn' : 'success',
      label: `Verified ${fmtRelative(at)}`,
      title: `No errors found on ${fmtDateTime(at)} (${checkLevelLabel({ level: job.repo_check_level ?? 'quick' })})${failedNote}`,
    };
  }
  return {
    tone: job.repo_check_error ? 'danger' : 'muted',
    label: job.repo_check_error ? 'Check failed' : 'Not verified',
    title: job.repo_check_error
      ? `The integrity check could not finish: ${job.repo_check_error}`
      : 'The repository has never been checked for integrity',
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
          <h2>Integrity</h2>
          <IntegrityBadge job={job} />
        </div>
        <div className="panel-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={openSchedule}>
            <Icon name="clock" size={14} />
            Schedule
          </button>
          <button className="btn btn-primary btn-sm" onClick={openCheck} disabled={active}>
            <Icon name="shield" size={14} />
            {active ? 'Check running…' : 'Check now'}
          </button>
        </div>
      </div>

      {job.repo_check_status === 'damaged' && (
        <div className="integrity-alert warn-box">
          {`restic found damaged data in this repository (${fmtDateTime(job.repo_check_at)}). Snapshots that reference it may not restore completely. Open the failed check's log below for the affected data and the repair commands restic suggests, then run a new backup and check again.`}
        </div>
      )}

      <div className="integrity-facts">
        <Fact
          label="Last verdict"
          value={verdictText(job)}
          sub={
            job.repo_check_at
              ? `${fmtDateTime(job.repo_check_at)} · ${checkLevelLabel({ level: job.repo_check_level ?? 'quick' })}`
              : 'Start a check to verify the repository'
          }
        />
        <DataFact job={job} />
        <Fact
          label="Schedule"
          value={
            config.enabled && config.cronExpr
              ? (describeCron(config.cronExpr) ?? config.cronExpr)
              : 'Not scheduled'
          }
          sub={
            config.enabled && config.cronExpr
              ? `${checkLevelLabel({ level: config.level ?? 'quick' })}${
                  job.next_check ? ` · next ${fmtRelative(job.next_check)}` : job.enabled ? '' : ' · job disabled'
                }`
              : 'Checks only run when started by hand'
          }
        />
      </div>

      {job.repo_check_error && (
        <div className="integrity-note" title={job.repo_check_error}>
          {`Last attempt could not finish: ${errorSummary(job.repo_check_error)}`}
        </div>
      )}

      <div className="integrity-runs">
        <div className="integrity-runs-head">Recent checks</div>
        {!runs.data ? (
          runs.error ? (
            <div className="empty">{runs.error.message}</div>
          ) : (
            <div className="loading">
              <Spinner />
            </div>
          )
        ) : runs.data.length === 0 ? (
          <div className="empty">No checks yet.</div>
        ) : (
          runs.data.map((r) => <CheckRunRow key={r.id} run={r} onChanged={runs.reload} />)
        )}
      </div>
    </div>
  );
}

function verdictText(job: Job): string {
  if (job.repo_check_status === 'passed') return 'No errors found';
  if (job.repo_check_status === 'damaged') return 'Integrity errors found';
  return 'Never checked';
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
      label="All data read back"
      value={job.repo_data_verified_at ? fmtRelative(job.repo_data_verified_at) : 'Never'}
      sub={
        parts
          ? completed
            ? `Rotation complete — the next run starts over at part 1 of ${parts}`
            : `Rotation: ${done} of ${parts} parts read`
          : job.repo_data_verified_at
            ? fmtDateTime(job.repo_data_verified_at)
            : 'Run a full or rotating check to read the data back'
      }
    >
      {parts ? (
        <div className="progress-track integrity-rotation" title={`${shown} of ${parts} parts`}>
          <div className="fill" style={{ width: `${Math.round((shown / parts) * 100)}%` }} />
        </div>
      ) : null}
    </Fact>
  );
}

function CheckRunRow({ run: r, onChanged }: { run: Run; onChanged: () => void }) {
  const toast = useToast();
  const { open } = useModal();
  const damaged = r.check_info?.damaged === true;

  const cancel = async () => {
    try {
      await api.post(`/runs/${r.id}/cancel`);
      toast('Check cancelled', 'success');
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not cancel the check', 'error');
    }
  };

  const sub =
    r.status === 'success'
      ? 'no errors found'
      : damaged
        ? 'integrity errors found'
        : r.status === 'failed' && r.error
          ? errorSummary(r.error)
          : statusLabel(r.status);

  return (
    <div className="row compact">
      <span className={`status-dot ${damaged ? 'failed' : r.status}`} />
      <div className="row-main">
        <div className="row-title">
          {checkLevelLabel(r.check_info)}
          {r.trigger === 'schedule' && <span className="badge muted row-kind">scheduled</span>}
        </div>
        <div className="row-sub integrity-run-sub" title={r.error ?? undefined}>
          {sub}
        </div>
      </div>
      <div className="row-meta run-meta">
        <span>
          {damaged ? (
            <span className="badge danger">damaged</span>
          ) : r.status !== 'success' ? (
            <span className={`badge ${r.status === 'failed' ? 'danger' : r.status === 'queued' ? 'info' : 'muted'}`}>
              {statusLabel(r.status)}
            </span>
          ) : (
            <span className="badge success">passed</span>
          )}
        </span>
        <span className="muted" title="Duration">
          {r.started_at ? fmtDuration(runDurationMs(r)) : ''}
        </span>
        <span className="muted">{fmtRelative(r.finished_at ?? r.created_at)}</span>
      </div>
      <div className="row-actions">
        {isActive(r.status) ? (
          <button className="btn btn-ghost btn-sm" onClick={() => void cancel()}>
            <Icon name="x" size={14} />
            Cancel
          </button>
        ) : (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => open((close) => <RunLogModal runId={r.id} title={checkLevelLabel(r.check_info)} onClose={close} />)}
          >
            <Icon name="file" size={14} />
            Log
          </button>
        )}
      </div>
    </div>
  );
}

function RunLogModal({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => api.get<Run & { log?: string | null }>(`/runs/${runId}`), [runId]);
  return (
    <ModalFrame title={`Check log — ${title}`} wide onClose={onClose}>
      {loading ? (
        <div className="loading">
          <Spinner />
        </div>
      ) : error ? (
        <div className="empty">{error.message}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data?.error && <div className="warn-box">{data.error}</div>}
          <pre className="run-log">{data?.log?.trim() || 'No output recorded.'}</pre>
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
  return (
    <div className="level-options" role="radiogroup">
      {LEVELS.map((l) => {
        let desc = l.desc;
        if (l.value === 'rotating') {
          const next =
            job.repo_check_subset_parts === parts ? (job.repo_check_subset_next ?? 1) : 1;
          desc = `${l.desc} Next: part ${next} of ${parts}.`;
        }
        return (
          <label key={l.value} className={`level-option${value === l.value ? ' selected' : ''}`}>
            <input
              type="radio"
              name="integrity-level"
              checked={value === l.value}
              onChange={() => onChange(l.value)}
            />
            <span>
              <span className="level-option-title">{l.title}</span>
              <span className="level-option-desc">{desc}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function CheckDialog({ job, onClose, onStarted }: { job: Job; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const config = job.integrity_check ?? {};
  const [level, setLevel] = useState<IntegrityLevel>(config.level ?? 'quick');
  const parts = config.subsetParts ?? DEFAULT_SUBSET_PARTS;

  const submit = async () => {
    try {
      await api.post(`/jobs/${job.id}/check`, { level });
      toast('Integrity check started', 'success');
      onStarted();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the check', 'error');
      return false;
    }
  };

  return (
    <FormModal title={`Check integrity — ${job.name}`} confirmLabel="Start check" onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <LevelOptions value={level} onChange={setLevel} job={job} parts={parts} />
        {level === 'full' && job.target_id != null && (
          <div className="warn-box">
            Every data pack is downloaded from the storage backend. Depending on the repository size this can take hours
            and cause egress costs.
          </div>
        )}
        <span className="muted" style={{ fontSize: 12.5 }}>
          {job.location === 'agent'
            ? "The check runs on the job's agent and locks the repository while it runs — backups of this job fail during that time."
            : 'The check locks the repository while it runs — backups of this job fail during that time.'}
        </span>
      </div>
    </FormModal>
  );
}

function ScheduleDialog({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: () => void }) {
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
      toast('Parts must be a whole number between 2 and 100', 'error');
      return false;
    }
    try {
      await api.put(`/jobs/${job.id}/integrity-check`, {
        enabled,
        cronExpr: cron.trim(),
        level,
        subsetParts: level === 'rotating' ? partsNum : undefined,
      });
      toast('Check schedule saved', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the schedule', 'error');
      return false;
    }
  };

  return (
    <FormModal title={`Check schedule — ${job.name}`} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Check this repository on a schedule
        </label>
        <div className="field-row">
          <Field label="Preset">
            <select
              value={preset}
              disabled={!enabled}
              onChange={(e) => {
                if (e.target.value !== 'custom') setCron(e.target.value);
              }}
            >
              {CHECK_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cron" help="minute hour day month weekday">
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
          <div className={`cron-preview${cronDesc ? '' : ' invalid'}`}>{`→ ${cronDesc ?? 'Custom schedule'}`}</div>
        )}
        <LevelOptions value={level} onChange={setLevel} job={job} parts={partsValid ? partsNum : DEFAULT_SUBSET_PARTS} />
        {level === 'rotating' && (
          <Field
            label="Parts"
            help={
              partsValid
                ? `Each run reads 1/${partsNum} of the data — after ${partsNum} successful runs all data has been read back once.`
                : 'A whole number between 2 and 100'
            }
          >
            <input type="number" min="2" max="100" value={parts} onChange={(e) => setParts(e.target.value)} />
          </Field>
        )}
        <span className="muted" style={{ fontSize: 12.5 }}>
          Checks lock the repository. Pick a time when this job does not back up; a check that finds the repository
          busy is skipped until its next turn.
        </span>
      </div>
    </FormModal>
  );
}
