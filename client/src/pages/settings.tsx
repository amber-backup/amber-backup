import { useEffect, useState } from 'react';
import { api } from '../core/api';
import { Icon } from '../core/icons';
import { fmtRelative } from '../core/format';
import { copyToClipboard } from '../core/clipboard';
import { useAuth } from '../core/auth';
import { passkeysSupported, registerPasskey, type Passkey } from '../core/passkeys';
import { useAsync } from '../hooks/useAsync';
import { LOCALES, useI18n, useT, type Locale } from '../i18n';
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
  const t = useT();
  const { user, isAdmin, logout, refresh } = useAuth();
  const { open } = useModal();
  const { data: keys, loading, reload } = useAsync(() => api.get<ApiKey[]>('/api-keys'));

  if (loading || !keys) return <Loading label={t.common.loading} />;

  const isLocal = user?.auth_source === 'local';

  return (
    <div>
      <PageHeader
        title={t.settings.title}
        subtitle={t.settings.subtitle}
        actions={<ActionButton label={t.common.nav.signOut} icon="logout" variant="ghost" onClick={() => void logout()} />}
      />

      <div className="panel">
        <div className="panel-head">
          <h2>{t.settings.profile.title}</h2>
          {isLocal && (
            <span className="link" onClick={() => open((close) => <ChangePasswordModal onClose={close} />)}>
              {t.settings.profile.changePassword}
            </span>
          )}
        </div>
        <div className="row">
          <div className="row-main">
            <div className="row-title">{user?.display_name ?? ''}</div>
            <div className="row-sub">{`${user?.email} · ${isAdmin ? t.common.administrator : t.common.user}`}</div>
          </div>
        </div>
      </div>

      <LanguagePanel />

      {isLocal && (
        <div className="panel section-gap">
          <div className="panel-head">
            <h2>{t.settings.twoFactor.title}</h2>
            {user?.totp_enabled ? (
              <span
                className="link"
                onClick={() => open((close) => <DisableTwoFactorModal onClose={close} onDone={refresh} />)}
              >
                {t.settings.twoFactor.disable}
              </span>
            ) : (
              <span
                className="link"
                onClick={() => open((close) => <EnableTwoFactorModal onClose={close} onDone={refresh} />)}
              >
                {t.settings.twoFactor.enable}
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
              <div className="row-title">{user?.totp_enabled ? t.settings.twoFactor.enabled : t.settings.twoFactor.disabled}</div>
              <div className="row-sub">
                {user?.totp_enabled
                  ? t.settings.twoFactor.enabledHelp
                  : t.settings.twoFactor.disabledHelp}
              </div>
            </div>
          </div>
        </div>
      )}

      {passkeysSupported() && <PasskeysPanel />}

      <div className="panel section-gap">
        <div className="panel-head">
          <h2>{t.settings.apiKeys.title}</h2>
          <span
            className="link"
            onClick={() => open((close) => <CreateKeyModal onClose={close} onCreated={reload} />)}
          >
            {t.settings.apiKeys.newKey}
          </span>
        </div>
        {keys.length === 0 ? (
          <Empty>{t.settings.apiKeys.empty}</Empty>
        ) : (
          keys.map((k) => <KeyRow key={k.id} apiKey={k} reload={reload} />)
        )}
      </div>
    </div>
  );
}

function LanguagePanel() {
  const { t, preference, setPreference } = useI18n();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const change = async (value: string) => {
    setSaving(true);
    try {
      await setPreference(value === 'auto' ? null : (value as Locale));
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.error, 'error');
      setSaving(false);
    }
  };

  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>{t.settings.language.title}</h2>
      </div>
      <div className="row">
        <span className="stat-icon" style={{ background: 'var(--bg-3)', color: 'var(--text-2)' }}>
          <Icon name="globe" size={16} />
        </span>
        <div className="row-main">
          <div className="row-title">{t.settings.language.label}</div>
          <div className="row-sub">{t.settings.language.help}</div>
        </div>
        <select
          value={preference ?? 'auto'}
          disabled={saving}
          className="select"
          onChange={(e) => void change(e.target.value)}
          style={{ width: 'auto' }}
        >
          <option value="auto">{t.settings.language.auto}</option>
          {LOCALES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function KeyRow({ apiKey: k, reload }: { apiKey: ApiKey; reload: () => void }) {
  const t = useT();
  const toast = useToast();
  const { confirmDialog } = useModal();

  return (
    <div className="row">
      <span className="stat-icon" style={{ background: 'var(--bg-3)', color: 'var(--text-2)' }}>
        <Icon name="key" size={16} />
      </span>
      <div className="row-main">
        <div className="row-title">{k.name}</div>
        <div className="row-sub">{t.settings.apiKeys.meta(
          k.prefix,
          k.scopes.actions.map((a) => t.settings.createKey.scopeLabels[a] ?? a).join(', '),
          fmtRelative(k.last_used_at),
        )}</div>
      </div>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() =>
          confirmDialog(
            t.settings.apiKeys.revokeTitle,
            t.settings.apiKeys.revokeConfirm(k.name),
            async () => {
              await api.del(`/api-keys/${k.id}`);
              toast(t.settings.apiKeys.revoked, 'success');
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
  const t = useT();
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
      toast(err instanceof Error ? err.message : t.common.error, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.settings.createKey.title} confirmLabel={t.settings.createKey.confirm} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={t.settings.createKey.name}>
          <input type="text" placeholder={t.settings.createKey.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t.settings.createKey.scopes}>
          <div style={{ display: 'flex', gap: 16 }}>
            {['read', 'operate', 'manage'].map((a) => (
              <label className="checkbox" key={a}>
                <input type="checkbox" checked={actions[a]} onChange={() => toggle(a)} />
                {t.settings.createKey.scopeLabels[a]}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t.settings.createKey.expiry}>
          <input
            type="number"
            placeholder={t.settings.createKey.expiryPlaceholder}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </Field>
      </div>
    </FormModal>
  );
}

function KeyCreatedModal({ keyValue, onClose }: { keyValue: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const copy = async () => {
    const ok = await copyToClipboard(keyValue);
    toast(ok ? t.common.copied : t.settings.keyCreated.copyFailed, ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title={t.settings.keyCreated.title}
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          {t.common.close}
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="warn-box">{t.settings.keyCreated.warning}</div>
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
            {t.common.copy}
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const submit = async () => {
    if (next.length < 8) {
      toast(t.settings.changePassword.tooShort, 'error');
      return false;
    }
    if (next !== confirm) {
      toast(t.settings.changePassword.mismatch, 'error');
      return false;
    }
    try {
      await api.post('/auth/change-password', {
        currentPassword: current,
        newPassword: next,
      });
      toast(t.settings.changePassword.changed, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t.settings.changePassword.failed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.settings.changePassword.title} confirmLabel={t.settings.changePassword.confirm} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label={t.settings.changePassword.current}>
          <input
            type="password"
            placeholder={t.settings.changePassword.current}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label={t.settings.changePassword.next}>
          <input
            type="password"
            placeholder={t.settings.changePassword.nextPlaceholder}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label={t.settings.changePassword.repeat}>
          <input
            type="password"
            placeholder={t.settings.changePassword.repeatPlaceholder}
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
  const t = useT();
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
      .catch((e) => active && setError(e instanceof Error ? e.message : t.settings.enableTwoFactor.setupFailed));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (!setup) return false;
    if (!/^\d{6}$/.test(code.trim())) {
      toast(t.settings.enableTwoFactor.invalidFormat, 'error');
      return false;
    }
    try {
      const res = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', {
        code: code.trim(),
      });
      onDone();
      toast(t.settings.enableTwoFactor.enabledToast, 'success');
      open((close) => <RecoveryCodesModal codes={res.recoveryCodes} onClose={close} />);
    } catch (err) {
      toast(err instanceof Error ? err.message : t.settings.enableTwoFactor.invalidCode, 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={t.settings.enableTwoFactor.title}
      confirmLabel={t.settings.enableTwoFactor.confirm}
      onClose={onClose}
      onSubmit={submit}
    >
      {error ? (
        <div className="warn-box">{error}</div>
      ) : !setup ? (
        <Loading label={t.settings.enableTwoFactor.preparing} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="row-sub">{t.settings.enableTwoFactor.scanHelp}</div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <img
              src={setup.qrDataUrl}
              width={200}
              height={200}
              alt={t.settings.enableTwoFactor.qrAlt}
              style={{ borderRadius: 8, background: '#fff', padding: 8 }}
            />
          </div>
          <div>
            <div className="row-sub" style={{ marginBottom: 6 }}>
              {t.settings.enableTwoFactor.manualKey}
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
          <Field label={t.settings.enableTwoFactor.codeLabel}>
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
  const t = useT();
  const toast = useToast();
  const copy = async () => {
    const ok = await copyToClipboard(codes.join('\n'));
    toast(ok ? t.common.copied : t.settings.recoveryCodes.copyFailed, ok ? 'success' : 'error');
  };

  return (
    <ModalFrame
      title={t.settings.recoveryCodes.title}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t.settings.recoveryCodes.done}
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="warn-box">{t.settings.recoveryCodes.warning}</div>
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
            {t.settings.recoveryCodes.copyAll}
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}

function PasskeysPanel() {
  const t = useT();
  const { open, confirmDialog } = useModal();
  const toast = useToast();
  const { data: passkeys, loading, reload } = useAsync(() =>
    api.get<Passkey[]>('/auth/passkeys'),
  );

  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>{t.settings.passkeys.title}</h2>
        <span
          className="link"
          onClick={() => open((close) => <AddPasskeyModal onClose={close} onAdded={reload} />)}
        >
          {t.settings.passkeys.add}
        </span>
      </div>
      {loading || !passkeys ? (
        <Loading label={t.common.loading} />
      ) : passkeys.length === 0 ? (
        <Empty>{t.settings.passkeys.empty}</Empty>
      ) : (
        passkeys.map((p) => (
          <div className="row" key={p.id}>
            <span className="stat-icon" style={{ background: 'var(--bg-3)', color: 'var(--text-2)' }}>
              <Icon name="key" size={16} />
            </span>
            <div className="row-main">
              <div className="row-title">{p.name}</div>
              <div className="row-sub">
                {t.settings.passkeys.meta(fmtRelative(p.created_at), fmtRelative(p.last_used_at))}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() =>
                confirmDialog(
                  t.settings.passkeys.removeTitle,
                  t.settings.passkeys.removeConfirm(p.name),
                  async () => {
                    await api.del(`/auth/passkeys/${p.id}`);
                    toast(t.settings.passkeys.removed, 'success');
                    reload();
                  },
                  true,
                )
              }
            >
              <Icon name="trash" />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function AddPasskeyModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState('');

  const submit = async () => {
    try {
      await registerPasskey(name.trim() || t.settings.addPasskey.defaultName);
      onAdded();
      toast(t.settings.addPasskey.added, 'success');
    } catch (e) {
      // Dismissing the native prompt just cancels — keep the dialog open quietly.
      if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'NotAllowedError') {
        return false;
      }
      toast(e instanceof Error ? e.message : t.settings.addPasskey.failed, 'error');
      return false;
    }
  };

  return (
    <FormModal title={t.settings.addPasskey.title} confirmLabel={t.settings.addPasskey.confirm} onClose={onClose} onSubmit={submit}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="row-sub">{t.settings.addPasskey.help}</div>
        <Field label={t.settings.addPasskey.name}>
          <input
            type="text"
            placeholder={t.settings.addPasskey.namePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
      </div>
    </FormModal>
  );
}

function DisableTwoFactorModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [password, setPassword] = useState('');

  const submit = async () => {
    try {
      await api.post('/auth/2fa/disable', { password });
      onDone();
      toast(t.settings.disableTwoFactor.disabledToast, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t.settings.disableTwoFactor.failed, 'error');
      return false;
    }
  };

  return (
    <FormModal
      title={t.settings.disableTwoFactor.title}
      confirmLabel={t.settings.disableTwoFactor.confirm}
      onClose={onClose}
      onSubmit={submit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="warn-box">{t.settings.disableTwoFactor.warning}</div>
        <Field label={t.settings.disableTwoFactor.password}>
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
