import { useState } from 'react';
import { api } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { copyToClipboard } from '../core/clipboard';
import { useAuth } from '../core/auth';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal, FormModal, ModalFrame } from '../ui/modal';
import { PageHeader, ActionButton, Field, Loading, Empty } from '../ui/primitives';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: { actions: string[] };
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export function Settings() {
  const { user, isAdmin, logout } = useAuth();
  const { open } = useModal();
  const { data: keys, loading, reload } = useAsync(() => api.get<ApiKey[]>('/api-keys'));

  if (loading || !keys) return <Loading label="Loading…" />;

  const isLocal = user?.auth_source === 'local';

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Profile, API keys and SSO"
        actions={<ActionButton label="Sign out" icon="logout" variant="ghost" onClick={() => void logout()} />}
      />

      <div className="panel">
        <div className="panel-head">
          <h2>Profile</h2>
          {isLocal && (
            <span className="link" onClick={() => open((close) => <ChangePasswordModal onClose={close} />)}>
              Change password
            </span>
          )}
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">{user?.display_name ?? ''}</div>
            <div className="row-sub">{`${user?.email} · ${isAdmin ? 'Administrator' : 'User'}`}</div>
          </div>
        </div>
      </div>

      <div className="panel section-gap">
        <div className="panel-head">
          <h2>API keys</h2>
          <span
            className="link"
            onClick={() => open((close) => <CreateKeyModal onClose={close} onCreated={reload} />)}
          >
            + New key
          </span>
        </div>
        {keys.length === 0 ? (
          <Empty>No API keys. Create one for third-party applications.</Empty>
        ) : (
          keys.map((k) => <KeyRow key={k.id} apiKey={k} reload={reload} />)
        )}
      </div>
    </div>
  );
}

function KeyRow({ apiKey: k, reload }: { apiKey: ApiKey; reload: () => void }) {
  const toast = useToast();
  const { confirmDialog } = useModal();

  return (
    <div className="row">
      <span className="stat-icon" style={{ background: 'var(--bg-3)', color: 'var(--text-2)' }}>
        <Icon name="key" size={16} />
      </span>
      <div className="row-main">
        <div className="row-title">{k.name}</div>
        <div className="row-sub">{`${k.prefix}… · actions: ${k.scopes.actions.join(', ')} · last used ${fmtRelative(k.last_used_at)}`}</div>
      </div>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() =>
          confirmDialog(
            'Revoke key',
            `"${k.name}" becomes invalid immediately.`,
            async () => {
              await api.del(`/api-keys/${k.id}`);
              toast('Key revoked', 'success');
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

function CreateKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const { open } = useModal();
  const [name, setName] = useState('');
  const [actions, setActions] = useState<Record<string, boolean>>({ read: true, operate: false, manage: false });
  const [expiry, setExpiry] = useState('');

  const toggle = (a: string) => setActions((cur) => ({ ...cur, [a]: !cur[a] }));

  const submit = async () => {
    const selectedActions = Object.entries(actions)
      .filter(([, checked]) => checked)
      .map(([a]) => a);
    try {
      const res = await api.post<{ key: string; name: string }>('/api-keys', {
        name,
        scopes: { actions: selectedActions.length ? selectedActions : ['read'] },
        expiresInDays: expiry ? Number(expiry) : undefined,
      });
      onCreated();
      open((close) => <KeyCreatedModal keyValue={res.key} onClose={close} />);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
      return false;
    }
  };

  return (
    <FormModal title="Create API key" confirmLabel="Create" onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Name">
          <input type="text" placeholder="e.g. CI pipeline" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Scopes">
          <div style={{ display: 'flex', gap: 16 }}>
            {['read', 'operate', 'manage'].map((a) => (
              <label className="checkbox" key={a}>
                <input type="checkbox" checked={actions[a]} onChange={() => toggle(a)} />
                {a}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Expiry">
          <input
            type="number"
            placeholder="Days until expiry (blank = never)"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </Field>
      </div>
    </FormModal>
  );
}

function KeyCreatedModal({ keyValue, onClose }: { keyValue: string; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    const ok = await copyToClipboard(keyValue);
    toast(ok ? 'Copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title="API key created"
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="warn-box">This key is shown only once. Copy it now.</div>
        <div
          className="mono"
          style={{
            background: 'var(--bg-0)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
            fontSize: 12,
            wordBreak: 'break-all',
            color: 'var(--amber-light)',
          }}
        >
          {keyValue}
        </div>
        <div>
          <button className="btn btn-ghost btn-sm" onClick={copy}>
            <Icon name="copy" />
            Copy
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const submit = async () => {
    if (next.length < 8) {
      toast('New password must be at least 8 characters', 'error');
      return false;
    }
    if (next !== confirm) {
      toast('New passwords do not match', 'error');
      return false;
    }
    try {
      await api.post('/auth/change-password', {
        currentPassword: current,
        newPassword: next,
      });
      toast('Password changed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to change password', 'error');
      return false;
    }
  };

  return (
    <FormModal title="Change password" confirmLabel="Update password" onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Current password">
          <input
            type="password"
            placeholder="Current password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password">
          <input
            type="password"
            placeholder="New password (min. 8 characters)"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            placeholder="Repeat new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </div>
    </FormModal>
  );
}
