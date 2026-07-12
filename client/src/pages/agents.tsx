import { useState } from 'react';
import { api, type Agent } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { copyToClipboard } from '../core/clipboard';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, ModalFrame } from '../ui/modal';
import { PageHeader, ActionButton, Loading } from '../ui/primitives';

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
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="binary">Binary (systemd)</option>
      <option value="docker">Docker</option>
      <option value="docker-compose">Docker Compose</option>
    </select>
  );
}

function intro(method: string): string {
  return method === 'docker-compose'
    ? 'Save as docker-compose.yml on the target server, then run "docker compose up -d":'
    : 'Run on the target server:';
}

export function Agents() {
  const { data, loading, reload } = useAsync(() => api.get<Agent[]>('/agents'));
  const { open } = useModal();

  if (loading || !data) return <Loading label="Loading…" />;
  const agents = data;
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
        title="Agents"
        subtitle={`${online} of ${agents.length} online`}
        actions={<ActionButton label="Roll out agent" icon="plus" variant="primary" onClick={() => void openEnroll()} />}
      />
      <div className="panel">
        <div className="panel-head">
          <h2>Server fleet</h2>
        </div>
        {agents.length > 0 && (
          <div className="table-head" style={{ gridTemplateColumns: '1.6fr 1fr 1fr 1fr 40px' }}>
            <span>Host</span>
            <span>Agent</span>
            <span>Last contact</span>
            <span>Restic</span>
            <span />
          </div>
        )}
        {agents.length === 0 ? (
          <div className="empty">No agents yet. Roll out an agent on a remote server.</div>
        ) : (
          agents.map((a) => <AgentRow key={a.id} agent={a} reload={reload} />)
        )}
      </div>
    </div>
  );
}

function AgentRow({ agent: a, reload }: { agent: Agent; reload: () => void }) {
  const toast = useToast();
  const { confirmDialog } = useModal();

  return (
    <div className="row" style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 40px', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span className={`status-dot ${a.status}`} />
        <div style={{ minWidth: 0 }}>
          <div className="row-title">{a.name}</div>
          <div className="row-sub">{`${a.hostname ?? '?'} · ${a.os ?? ''}`}</div>
        </div>
      </div>
      <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
        {a.agent_version ? `v${a.agent_version}` : <span className="badge info">installing…</span>}
      </div>
      <div style={{ fontSize: 12.5, color: `var(--${a.status === 'offline' ? 'danger' : 'text-2'})` }}>
        {a.last_seen_at ? fmtRelative(a.last_seen_at) : 'never'}
      </div>
      <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
        {a.restic_version ?? '—'}
      </div>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() =>
          confirmDialog(
            'Remove agent',
            `"${a.name}" will be removed. The agent will no longer be able to check in.`,
            async () => {
              await api.del(`/agents/${a.id}`);
              toast('Agent removed', 'success');
              reload();
            },
            true,
          )
        }
      >
        <Icon name="trash" />
      </button>
    </div>
  );
}

/** Self-registration: the global token is already active; just pick a name. */
function GlobalRollout({ global, onClose }: { global: GlobalEnroll; onClose: () => void }) {
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
    toast(ok ? 'Command copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title="Roll out agent"
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="field">
          <label>Agent name</label>
          <input type="text" placeholder="e.g. web-01" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Method</label>
          <MethodSelect value={method} onChange={setMethod} />
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>{intro(method)}</p>
        <div className="mono" style={CMD_STYLE}>
          {shownCommand}
        </div>
        <div className="help" style={{ color: 'var(--text-2)', display: ready ? 'none' : 'block' }}>
          Enter an agent name to get the command.
        </div>
        <div>
          <button className="btn btn-ghost btn-sm" disabled={!ready} onClick={() => void copy()}>
            <Icon name="copy" />
            Copy
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

/** One-time tokens: generate a short-lived token per agent. */
function TokenRollout({ onClose }: { onClose: () => void }) {
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
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!result) return;
    const ok = await copyToClipboard(result.installCommand);
    toast(ok ? 'Command copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title="Roll out agent"
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="field">
          <label>Agent name</label>
          <input
            type="text"
            placeholder="e.g. web-01 (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Method</label>
          <MethodSelect value={method} onChange={setMethod} />
        </div>
        <div>
          <button className="btn btn-primary" disabled={busy} onClick={() => void generate()}>
            Generate token
          </button>
        </div>
        <div>
          {result && (
            <>
              <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 10 }}>
                {`${intro(result.deployMethod)} (valid for 60 min):`}
              </p>
              <div className="mono" style={CMD_STYLE}>
                {result.installCommand}
              </div>
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => void copy()}>
                  <Icon name="copy" />
                  Copy
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalFrame>
  );
}
