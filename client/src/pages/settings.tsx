import { useEffect, useState } from 'react';
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
  const { user, isAdmin, logout, refresh } = useAuth();
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

      {isLocal && (
        <div className="panel section-gap">
          <div className="panel-head">
            <h2>Two-factor authentication</h2>
            {user?.totp_enabled ? (
              <span
                className="link"
                onClick={() => open((close) => <DisableTwoFactorModal onClose={close} onDone={refresh} />)}
              >
                Disable
              </span>
            ) : (
              <span
                className="link"
                onClick={() => open((close) => <EnableTwoFactorModal onClose={close} onDone={refresh} />)}
              >
                Enable
              </span>
            )}
          </div>
          <div className="row">
            <span
              className="stat-icon"
              style={{
                background: user?.totp_enabled ? 'var(--amber-glow)' : 'var(--bg-3)',
                color: user?.totp_enabled ? 'var(--amber)' : 'var(--text-2)',
              }}
            >
              <Icon name="shield" size={16} />
            </span>
            <div className="row-main">
              <div className="row-title">{user?.totp_enabled ? 'Enabled' : 'Disabled'}</div>
              <div className="row-sub">
                {user?.totp_enabled
                  ? 'A code from your authenticator app is required at sign-in.'
                  : 'Protect sign-in with a time-based code from an authenticator app.'}
              </div>
            </div>
          </div>
        </div>
      )}

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

interface TotpSetup {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

function EnableTwoFactorModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { open } = useModal();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  // Ask the server for a fresh (pending) secret + QR when the dialog opens.
  useEffect(() => {
    let active = true;
    api
      .post<TotpSetup>('/auth/2fa/setup')
      .then((s) => active && setSetup(s))
      .catch((e) => active && setError(e instanceof Error ? e.message : 'Failed to start setup'));
    return () => {
      active = false;
    };
  }, []);

  const submit = async () => {
    if (!setup) return false;
    if (!/^\d{6}$/.test(code.trim())) {
      toast('Enter the 6-digit code from your app', 'error');
      return false;
    }
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', {
        code: code.trim(),
      });
      onDone();
      toast('Two-factor authentication enabled', 'success');
      open((close) => <RecoveryCodesModal codes={res.recoveryCodes} onClose={close} />);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Invalid code', 'error');
      return false;
    }
  };

  return (
    <FormModal
      title="Enable two-factor authentication"
      confirmLabel="Verify & enable"
      onClose={onClose}
      onSubmit={submit}
    >
      {error ? (
        <div className="warn-box">{error}</div>
      ) : !setup ? (
        <Loading label="Preparing…" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="row-sub">
            Scan this QR code with an authenticator app (Google Authenticator, 1Password,
            Authy…), then enter the 6-digit code it shows.
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <img
              src={setup.qrDataUrl}
              width={200}
              height={200}
              alt="TOTP QR code"
              style={{ borderRadius: 8, background: '#fff', padding: 8 }}
            />
          </div>
          <div>
            <div className="row-sub" style={{ marginBottom: 6 }}>
              Or enter this key manually:
            </div>
            <div
              className="mono"
              style={{
                background: 'var(--bg-0)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12,
                wordBreak: 'break-all',
                color: 'var(--amber-light)',
              }}
            >
              {setup.secret}
            </div>
          </div>
          <Field label="Authentication code">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>
      )}
    </FormModal>
  );
}

function RecoveryCodesModal({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const toast = useToast();
  const copy = async () => {
    const ok = await copyToClipboard(codes.join('\n'));
    toast(ok ? 'Copied' : 'Copy failed — select manually', ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title="Recovery codes"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="warn-box">
          Store these somewhere safe. Each code works once and lets you sign in if you lose your
          authenticator. They are shown only now.
        </div>
        <div
          className="mono"
          style={{
            background: 'var(--bg-0)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
            fontSize: 13,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px 20px',
            color: 'var(--amber-light)',
          }}
        >
          {codes.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
        <div>
          <button className="btn btn-ghost btn-sm" onClick={copy}>
            <Icon name="copy" />
            Copy all
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

function DisableTwoFactorModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');

  const submit = async () => {
    try {
      await api.post('/auth/2fa/disable', { password });
      onDone();
      toast('Two-factor authentication disabled', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to disable', 'error');
      return false;
    }
  };

  return (
    <FormModal
      title="Disable two-factor authentication"
      confirmLabel="Disable"
      onClose={onClose}
      onSubmit={submit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="warn-box">
          This removes the second factor from your account. Confirm your password to continue.
        </div>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </div>
    </FormModal>
  );
}
