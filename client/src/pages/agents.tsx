import { useEffect, useState } from 'react';
import { api, type Agent } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { copyToClipboard } from '../core/clipboard';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, ModalFrame, FormModal } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading } from '../ui/primitives';
import { useT } from '../i18n';
import type { AgentsMessages } from '../i18n/en/agents';

interface EnrollToken {
  token: string;
  expiresAt: string;
  deployMethod: string;
  installCommand: string;
}

interface GlobalEnroll {
  enabled: boolean;
  token: string | null;
  commands: Record<string, string> | null;
  namePlaceholder: string;
}

const CMD_STYLE: React.CSSProperties = {
  background: 'var(--bg-0)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '12px 14px',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: 'var(--amber-light)',
};

function MethodSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT().agents.methods;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="binary">{t.binary}</option>
      <option value="docker">{t.docker}</option>
      <option value="docker-compose">{t.dockerCompose}</option>
    </select>
  );
}

/** Instruction above the install command; with `validMinutes`, notes how long a one-time token lasts. */
function intro(t: AgentsMessages['intro'], method: string, validMinutes?: number): string {
  const compose = method === 'docker-compose';
  if (validMinutes != null) return compose ? t.composeValid(validMinutes) : t.runValid(validMinutes);
  return compose ? t.compose : t.run;
}

/** A new agent enrolls from its own host, so the list is polled to show it (and live status). */
const REFRESH_MS = 5000;

export function Agents() {
  const t = useT();
  const { data, loading, reload } = useAsync(() => api.get<Agent[]>('/agents'));
  const { open } = useModal();
  // Quiet background refresh; `reload()` would flash the loading screen each time.
  const [live, setLive] = useState<Agent[] | null>(null);

  // A fresh load (e.g. after removing an agent) supersedes the last poll.
  useEffect(() => setLive(null), [data]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api
        .get<Agent[]>('/agents')
        .then(setLive)
        .catch(() => {
          /* transient error — try again on the next tick */
        });
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  if (loading || !data) return <Loading label={t.common.loading} />;
  const agents = live ?? data;
  const online = agents.filter((a) => a.status === 'online').length;

  const openEnroll = async (): Promise<void> => {
    let global: GlobalEnroll = { enabled: false, token: null, commands: null, namePlaceholder: '' };
    try {
      global = await api.get<GlobalEnroll>('/agents/enrollment/global');
    } catch {
      /* fall back to one-time tokens */
    }
    if (global.enabled && global.commands) {
      open((close) => <GlobalRollout global={global} onClose={close} />);
    } else {
      open((close) => <TokenRollout onClose={close} />);
    }
  };

  return (
    <div>
      <PageHeader
        title={t.agents.page.title}
        subtitle={t.agents.page.subtitle(online, agents.length)}
        actions={<ActionButton label={t.agents.page.rollOut} icon="plus" variant="primary" onClick={() => void openEnroll()} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>{t.agents.page.fleet}</h2>
        </div>
        {agents.length > 0 && (
          <div className="table-head agents-grid">
            <span>{t.agents.page.colHost}</span>
            <span className="agents-hide-mobile">{t.agents.page.colAgent}</span>
            <span>{t.agents.page.colLastContact}</span>
            <span className="agents-hide-mobile">{t.agents.page.colRestic}</span>
            <span />
          </div>
        )}
        {agents.length === 0 ? (
          <div className="empty">{t.agents.page.empty}</div>
        ) : (
          agents.map((a) => <AgentRow key={a.id} agent={a} reload={reload} />)
        )}
      </div>
    </div>
  );
}

function AgentRow({ agent: a, reload }: { agent: Agent; reload: () => void }) {
  const t = useT().agents.row;
  const toast = useToast();
  const { open, confirmDialog } = useModal();
  const labels = a.labels ?? [];
  const allowedIps = a.allowed_ips ?? [];

  return (
    <div className="row agents-grid">
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span className={`status-dot ${a.status}`} />
        <div style={{ minWidth: 0 }}>
          <div className="row-title">{a.name}</div>
          <div className="row-sub">{`${a.hostname ?? '?'} · ${a.os ?? ''}`}</div>
          {(labels.length > 0 || allowedIps.length > 0) && (
            <div className="tags agent-tags">
              {allowedIps.length > 0 && (
                <span className="badge info" title={allowedIps.join(', ')}>
                  {t.ipRestricted(allowedIps.length)}
                </span>
              )}
              {labels.map((label) => (
                <span className="tag" key={label}>
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mono agents-hide-mobile" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
        {a.agent_version ? `v${a.agent_version}` : <span className="badge info">{t.installing}</span>}
      </div>
      <div style={{ fontSize: 12.5, color: `var(--${a.status === 'offline' ? 'danger' : 'text-2'})` }}>
        {a.last_seen_at ? fmtRelative(a.last_seen_at) : t.never}
      </div>
      <div className="mono agents-hide-mobile" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
        {a.restic_version ?? '—'}
      </div>
      <div className="row-actions">
        <button
          className="btn btn-ghost btn-sm"
          title={t.edit}
          aria-label={t.edit}
          onClick={() => open((close) => <AgentEditor agent={a} onClose={close} onSaved={reload} />)}
        >
          <Icon name="edit" />
        </button>
        <button
          className="btn btn-ghost btn-sm"
          title={t.remove}
          aria-label={t.remove}
          onClick={() =>
            confirmDialog(
              t.remove,
              t.removeConfirm(a.name),
              async () => {
                await api.del(`/agents/${a.id}`);
                toast(t.removed, 'success');
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

/** Splits free text on commas, whitespace and newlines into trimmed, unique entries. */
function splitList(text: string, separators: RegExp): string[] {
  return [...new Set(text.split(separators).map((v) => v.trim()).filter(Boolean))];
}

/** Name, poll interval, labels and the IP allowlist of an enrolled agent. */
function AgentEditor({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: () => void }) {
  const { agents, common } = useT();
  const m = agents.editor;
  const toast = useToast();
  const [name, setName] = useState(agent.name);
  const [pollInterval, setPollInterval] = useState(String(agent.poll_interval_seconds));
  const [labelsText, setLabelsText] = useState((agent.labels ?? []).join(', '));
  const [ipsText, setIpsText] = useState((agent.allowed_ips ?? []).join('\n'));

  const ips = splitList(ipsText, /[\s,]+/);
  const lastIpListed = !!agent.last_ip && ips.includes(agent.last_ip);

  const submit = async () => {
    const interval = Number(pollInterval);
    if (!name.trim()) {
      toast(m.nameRequired, 'error');
      return false;
    }
    if (!Number.isInteger(interval) || interval < 5 || interval > 3600) {
      toast(m.pollIntervalInvalid, 'error');
      return false;
    }
    try {
      await api.patch(`/agents/${agent.id}`, {
        name: name.trim(),
        pollIntervalSeconds: interval,
        labels: splitList(labelsText, /,/),
        allowedIps: ips,
      });
      toast(m.saved, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : m.saveFailed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={m.title} confirmLabel={common.save} onClose={onClose} onSubmit={submit}>
      <div className="modal-form">
        <Field label={m.name}>
          <input type="text" value={name} maxLength={128} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={m.pollInterval} help={m.pollIntervalHelp}>
          <input
            type="number"
            min={5}
            max={3600}
            value={pollInterval}
            onChange={(e) => setPollInterval(e.target.value)}
          />
        </Field>
        <Field label={m.labels} help={m.labelsHelp}>
          <input
            type="text"
            value={labelsText}
            placeholder="prod, eu-west"
            onChange={(e) => setLabelsText(e.target.value)}
          />
        </Field>
        <Field label={m.allowedIps} help={m.allowedIpsHelp}>
          <textarea
            rows={4}
            className="mono"
            value={ipsText}
            placeholder={'203.0.113.7\n10.0.0.0/8'}
            onChange={(e) => setIpsText(e.target.value)}
          />
        </Field>
        {agent.last_ip && (
          <div className="help">
            {m.lastIp(agent.last_ip)}
            {!lastIpListed && (
              <>
                {' '}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setIpsText(ips.concat(agent.last_ip!).join('\n'))}
                >
                  {m.addLastIp}
                </button>
              </>
            )}
          </div>
        )}
        {ips.length > 0 && <div className="help">{m.allowlistWarning}</div>}
      </div>
    </FormModal>
  );
}

/** Self-registration: the global token is already active; just pick a name. */
function GlobalRollout({ global, onClose }: { global: GlobalEnroll; onClose: () => void }) {
  const { agents, common } = useT();
  const t = agents.rollout;
  const toast = useToast();
  const [name, setName] = useState('');
  const [method, setMethod] = useState('binary');

  const ready = !!name.trim();
  const shownCommand = (global.commands![method] ?? '').replaceAll(
    global.namePlaceholder,
    name.trim() || '<agent-name>',
  );

  const copy = async (): Promise<void> => {
    if (!name.trim()) return;
    const ok = await copyToClipboard(shownCommand);
    toast(ok ? t.commandCopied : t.copyFailed, ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title={t.title}
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          {common.cancel}
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="field">
          <label>{t.name}</label>
          <input type="text" placeholder={t.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>{t.method}</label>
          <MethodSelect value={method} onChange={setMethod} />
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>{intro(agents.intro, method)}</p>
        <div className="mono" style={CMD_STYLE}>
          {shownCommand}
        </div>
        <div className="help" style={{ color: 'var(--text-2)', display: ready ? 'none' : 'block' }}>
          {t.enterName}
        </div>
        <div>
          <button className="btn btn-ghost btn-sm" disabled={!ready} onClick={() => void copy()}>
            <Icon name="copy" />
            {common.copy}
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

/** One-time tokens: generate a short-lived token per agent. */
function TokenRollout({ onClose }: { onClose: () => void }) {
  const { agents, common } = useT();
  const t = agents.rollout;
  const toast = useToast();
  const [name, setName] = useState('');
  const [method, setMethod] = useState('binary');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnrollToken | null>(null);

  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.post<EnrollToken>('/agents/enrollment-tokens', {
        intendedAgentName: name || undefined,
        deployMethod: method,
        expiresInMinutes: 60,
      });
      setResult(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : common.actionFailed, 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!result) return;
    const ok = await copyToClipboard(result.installCommand);
    toast(ok ? t.commandCopied : t.copyFailed, ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title={t.title}
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          {common.cancel}
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="field">
          <label>{t.name}</label>
          <input
            type="text"
            placeholder={t.namePlaceholderOptional}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label>{t.method}</label>
          <MethodSelect value={method} onChange={setMethod} />
        </div>
        <div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void generate()}>
            {t.generate}
          </button>
        </div>
        <div>
          {result && (
            <>
              <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>
                {intro(agents.intro, result.deployMethod, 60)}
              </p>
              <div className="mono" style={CMD_STYLE}>
                {result.installCommand}
              </div>
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => void copy()}>
                  <Icon name="copy" />
                  {common.copy}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}
