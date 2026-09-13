import { useRef, useState, type CSSProperties } from 'react';
import { api } from '../core/api';
import { Icon } from '../core/icons';
import { copyToClipboard } from '../core/clipboard';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal } from '../ui/modal';
import { PageHeader, Field, Loading, Empty } from '../ui/primitives';
import { useT } from '../i18n';

interface GlobalEnroll {
  enabled: boolean;
  token: string | null;
}

type SsoProviderType = 'oidc' | 'entra' | 'google' | 'github';

interface SsoProviderView {
  id: string;
  type: SsoProviderType;
  label: string;
  clientId: string;
  issuerUrl: string;
  tenantId: string;
  clientSecretSet: boolean;
}

interface SystemSettings {
  agentOfflineTimeoutSeconds: number;
  /** Whether password and passkey logins are accepted at all. */
  localLoginEnabled: boolean;
  sso: { enabled: boolean; providers: SsoProviderView[] };
  ssoRedirectUri: string;
}

/** Provider kinds selectable in the "Add provider" menu. */
const SSO_PROVIDER_META: {
  type: SsoProviderType;
  name: string;
  issuer?: boolean;
  tenant?: boolean;
}[] = [
  { type: 'oidc', name: 'OpenID Connect (OIDC)', issuer: true },
  { type: 'entra', name: 'Microsoft Entra ID', tenant: true },
  { type: 'google', name: 'Google' },
  { type: 'github', name: 'GitHub' },
];

const MONO_STYLE: CSSProperties = {
  background: 'var(--bg-0)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '12px 14px',
  fontSize: 12,
  wordBreak: 'break-all',
  color: 'var(--amber-light)',
};

const BODY_STYLE: CSSProperties = {
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const ACTIONS_STYLE: CSSProperties = { display: 'flex', justifyContent: 'flex-end' };

const SUBHEAD_STYLE: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--text-2)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
  marginTop: 4,
};

const CARD_STYLE: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '14px 16px',
  background: 'var(--bg-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

/** Admin-only system settings (agent self-registration, timeouts, SSO). */
export function Admin() {
  const t = useT();
  return (
    <div>
      <PageHeader title={t.admin.title} subtitle={t.admin.subtitle} />
      <EnrollPanel />
      <SystemPanels />
    </div>
  );
}

// --- Agent self-registration ------------------------------------------------

function EnrollPanel() {
  const t = useT();
  const toast = useToast();
  const { confirmDialog } = useModal();
  const { data, loading, error, reload } = useAsync(() =>
    api.get<GlobalEnroll>('/agents/enrollment/global'),
  );

  if (loading) {
    return (
      <div className="panel">
        <Loading label={t.common.loading} />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="panel">
        <Empty>{t.admin.enroll.loadFailed}</Empty>
      </div>
    );
  }

  const g = data;

  const onToggle = async (checked: boolean) => {
    try {
      await api.patch('/agents/enrollment/global', { enabled: checked });
      toast(checked ? t.admin.enroll.enabledToast : t.admin.enroll.disabledToast, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.error, 'error');
    }
    reload();
  };

  const copy = async (token: string) => {
    const ok = await copyToClipboard(token);
    toast(ok ? t.admin.enroll.tokenCopied : t.admin.copyFailed, ok ? 'success' : 'error');
  };

  const rotate = () =>
    confirmDialog(
      t.admin.enroll.rotateTitle,
      t.admin.enroll.rotateMessage,
      async () => {
        await api.post('/agents/enrollment/global/rotate');
        toast(t.admin.enroll.rotated, 'success');
        reload();
      },
    );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t.admin.enroll.heading}</h2>
      </div>
      <div className="row">
        <div className="row-main">
          <div className="row-title">{t.admin.enroll.globalToken}</div>
          <div className="row-sub">{t.admin.enroll.help}</div>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={g.enabled} onChange={(e) => void onToggle(e.target.checked)} />
          {t.admin.enroll.enabled}
        </label>
      </div>
      {g.enabled && g.token && (
        <div className="row">
          <div className="row-main" style={{ minWidth: 0 }}>
            <div className="row-title">{t.admin.enroll.token}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <div className="mono" style={{ ...MONO_STYLE, flex: 1, minWidth: 0 }}>
                {g.token}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                title={t.admin.enroll.copyToken}
                onClick={() => void copy(g.token!)}
              >
                <Icon name="copy" />
              </button>
              <button className="btn btn-ghost btn-sm" title={t.admin.enroll.rotateToken} onClick={rotate}>
                <Icon name="refresh" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Agents + SSO (both from GET /settings/system) --------------------------

function SystemPanels() {
  const t = useT();
  const { data, loading, error } = useAsync(() => api.get<SystemSettings>('/settings/system'));

  if (loading) {
    return (
      <>
        <div className="panel section-gap">
          <Loading label={t.common.loading} />
        </div>
        <div className="panel section-gap">
          <Loading label={t.common.loading} />
        </div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <div className="panel section-gap">
          <Empty>{t.admin.system.loadFailed}</Empty>
        </div>
        <div className="panel section-gap">
          <Empty>{t.admin.system.loadFailed}</Empty>
        </div>
      </>
    );
  }

  return (
    <>
      <AgentPanel sys={data} />
      <AuthPanel sys={data} />
      <SsoPanel sys={data} />
    </>
  );
}

// --- Local login ------------------------------------------------------------

/** Whether a provider has everything it needs to actually serve a login. */
function providerUsable(p: SsoProviderView): boolean {
  if (!p.clientId || !p.clientSecretSet) return false;
  if (p.type === 'oidc') return !!p.issuerUrl;
  if (p.type === 'entra') return !!p.tenantId;
  return true;
}

function AuthPanel({ sys }: { sys: SystemSettings }) {
  const t = useT();
  const toast = useToast();
  const [enabled, setEnabled] = useState(sys.localLoginEnabled);
  const [busy, setBusy] = useState(false);

  // The server refuses to leave an instance with no way in; mirror that here so
  // the checkbox explains itself instead of just failing.
  const ssoUsable = sys.sso.enabled && sys.sso.providers.some(providerUsable);

  const change = async (next: boolean) => {
    setBusy(true);
    try {
      const updated = await api.patch<SystemSettings>('/settings/auth', {
        localLoginEnabled: next,
      });
      setEnabled(updated.localLoginEnabled);
      toast(next ? t.admin.auth.enabledToast : t.admin.auth.disabledToast, 'success');
    } catch (err) {
      setEnabled(sys.localLoginEnabled);
      toast(err instanceof Error ? err.message : t.common.error, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>{t.admin.auth.heading}</h2>
      </div>
      <div style={BODY_STYLE}>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || (enabled && !ssoUsable)}
            onChange={(e) => void change(e.target.checked)}
          />
          {t.admin.auth.allowLocal}
        </label>
        <div className="help">
          {enabled && !ssoUsable ? t.admin.auth.needsSso : t.admin.auth.help}
        </div>
      </div>
    </div>
  );
}

// --- Agent offline timeout --------------------------------------------------

function AgentPanel({ sys }: { sys: SystemSettings }) {
  const t = useT();
  const toast = useToast();
  const [value, setValue] = useState(String(sys.agentOfflineTimeoutSeconds));

  const save = async () => {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
      toast(t.admin.agents.invalidTimeout, 'error');
      return;
    }
    try {
      await api.patch('/settings/agents', { offlineTimeoutSeconds: seconds });
      toast(t.admin.agents.saved, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.error, 'error');
    }
  };

  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>{t.admin.agents.heading}</h2>
      </div>
      <div style={BODY_STYLE}>
        <Field
          label={t.admin.agents.offlineTimeout}
          help={t.admin.agents.offlineTimeoutHelp}
        >
          <input
            type="number"
            min={30}
            max={3600}
            style={{ maxWidth: 160 }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <div style={ACTIONS_STYLE}>
          <button className="btn btn-primary btn-sm" onClick={() => void save()}>
            {t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- SSO --------------------------------------------------------------------

interface ProviderDraft {
  key: number;
  id: string;
  type: SsoProviderType;
  label: string;
  clientId: string;
  issuerUrl: string;
  tenantId: string;
  clientSecret: string; // blank leaves the stored secret unchanged
  clientSecretSet: boolean;
}

function SsoPanel({ sys }: { sys: SystemSettings }) {
  const t = useT();
  const toast = useToast();
  const nextKey = useRef(0);

  const toDrafts = (views: SsoProviderView[]): ProviderDraft[] =>
    views.map((v) => ({
      key: nextKey.current++,
      id: v.id,
      type: v.type,
      label: v.label,
      clientId: v.clientId,
      issuerUrl: v.issuerUrl,
      tenantId: v.tenantId,
      clientSecret: '',
      clientSecretSet: v.clientSecretSet,
    }));

  const [enabled, setEnabled] = useState(sys.sso.enabled);
  const [redirectUri, setRedirectUri] = useState(sys.ssoRedirectUri);
  const [providers, setProviders] = useState<ProviderDraft[]>(() => toDrafts(sys.sso.providers));
  const [menuOpen, setMenuOpen] = useState(false);

  const updateProvider = (key: number, patch: Partial<ProviderDraft>) =>
    setProviders((cur) => cur.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const removeProvider = (key: number) =>
    setProviders((cur) => cur.filter((p) => p.key !== key));

  const addProvider = (type: SsoProviderType) =>
    setProviders((cur) => [
      ...cur,
      {
        key: nextKey.current++,
        id: '',
        type,
        label: '',
        clientId: '',
        issuerUrl: '',
        tenantId: '',
        clientSecret: '',
        clientSecretSet: false,
      },
    ]);

  const copyRedirect = async () => {
    const ok = await copyToClipboard(redirectUri);
    toast(ok ? t.admin.sso.redirectCopied : t.admin.copyFailed, ok ? 'success' : 'error');
  };

  const collect = (): Record<string, unknown>[] =>
    providers.map((p) => {
      const meta = SSO_PROVIDER_META.find((m) => m.type === p.type)!;
      return {
        id: p.id || undefined,
        type: p.type,
        label: p.label.trim(),
        clientId: p.clientId.trim(),
        issuerUrl: meta.issuer ? p.issuerUrl.trim() : undefined,
        tenantId: meta.tenant ? p.tenantId.trim() : undefined,
        clientSecret: p.clientSecret, // blank leaves the stored secret unchanged
      };
    });

  const save = async () => {
    try {
      const updated = await api.put<SystemSettings>('/settings/sso', {
        enabled,
        providers: collect(),
      });
      toast(t.admin.sso.saved, 'success');
      setEnabled(updated.sso.enabled);
      setRedirectUri(updated.ssoRedirectUri);
      setProviders(toDrafts(updated.sso.providers));
    } catch (err) {
      toast(err instanceof Error ? err.message : t.common.error, 'error');
    }
  };

  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>{t.admin.sso.heading}</h2>
      </div>
      <div style={BODY_STYLE}>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t.admin.sso.enable}
        </label>
        {enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="row" style={{ padding: 0 }}>
              <div className="row-main" style={{ minWidth: 0 }}>
                <div className="row-title">{t.admin.sso.redirectUri}</div>
                <div className="row-sub">{t.admin.sso.redirectHelp}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <div className="mono" style={{ ...MONO_STYLE, flex: 1, minWidth: 0 }}>
                    {redirectUri}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    title={t.admin.sso.copyRedirect}
                    onClick={() => void copyRedirect()}
                  >
                    <Icon name="copy" />
                  </button>
                </div>
              </div>
            </div>
            <div style={SUBHEAD_STYLE}>{t.admin.sso.providers}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {providers.length === 0 ? (
                <div className="row-sub" style={{ padding: '2px 0' }}>
                  {t.admin.sso.noProviders}
                </div>
              ) : (
                providers.map((p) => (
                  <ProviderCard
                    key={p.key}
                    draft={p}
                    onChange={(patch) => updateProvider(p.key, patch)}
                    onRemove={() => removeProvider(p.key)}
                  />
                ))
              )}
            </div>
            <div>
              <div className="dropdown">
                <button className="btn btn-ghost btn-sm" onClick={() => setMenuOpen((o) => !o)}>
                  <Icon name="plus" />
                  {t.admin.sso.addProvider}
                </button>
                {menuOpen && (
                  <div className="dropdown-menu">
                    {SSO_PROVIDER_META.map((m) => (
                      <button
                        key={m.type}
                        className="dropdown-item"
                        onClick={() => {
                          setMenuOpen(false);
                          addProvider(m.type);
                        }}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <div style={ACTIONS_STYLE}>
          <button className="btn btn-primary btn-sm" onClick={() => void save()}>
            {t.admin.sso.save}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  draft,
  onChange,
  onRemove,
}: {
  draft: ProviderDraft;
  onChange: (patch: Partial<ProviderDraft>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const meta = SSO_PROVIDER_META.find((m) => m.type === draft.type)!;
  return (
    <div style={CARD_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{meta.name}</div>
        <button className="btn btn-ghost btn-sm" title={t.admin.sso.removeProvider} onClick={onRemove}>
          <Icon name="trash" />
        </button>
      </div>
      {meta.issuer && (
        <Field label={t.admin.sso.issuerUrl} help={t.admin.sso.issuerUrlHelp}>
          <input
            className="input"
            type="text"
            value={draft.issuerUrl}
            placeholder="https://id.example.com"
            onChange={(e) => onChange({ issuerUrl: e.target.value })}
          />
        </Field>
      )}
      {meta.tenant && (
        <Field label={t.admin.sso.tenantId}>
          <input
            className="input"
            type="text"
            value={draft.tenantId}
            placeholder={t.admin.sso.tenantIdPlaceholder}
            onChange={(e) => onChange({ tenantId: e.target.value })}
          />
        </Field>
      )}
      <Field label={t.admin.sso.clientId}>
        <input
          className="input"
          type="text"
          value={draft.clientId}
          onChange={(e) => onChange({ clientId: e.target.value })}
        />
      </Field>
      <Field
        label={t.admin.sso.clientSecret}
        help={draft.clientSecretSet ? t.admin.sso.secretStored : undefined}
      >
        <input
          className="input"
          type="password"
          placeholder={draft.clientSecretSet ? t.admin.sso.secretUnchanged : t.admin.sso.clientSecret}
          value={draft.clientSecret}
          onChange={(e) => onChange({ clientSecret: e.target.value })}
        />
      </Field>
      <Field label={t.admin.sso.buttonLabel} help={t.admin.sso.buttonLabelHelp(meta.name)}>
        <input
          className="input"
          type="text"
          value={draft.label}
          placeholder={meta.name}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </Field>
    </div>
  );
}
