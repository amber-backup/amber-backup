import { useRef, useState, type CSSProperties } from 'react';
import { api } from '../core/api';
import { Icon } from '../core/icons';
import { copyToClipboard } from '../core/clipboard';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../ui/toast';
import { useModal } from '../ui/modal';
import { PageHeader, Field, Loading, Empty } from '../ui/primitives';

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
  return (
    <div>
      <PageHeader title="Admin" subtitle="System-wide settings" />
      <EnrollPanel />
      <SystemPanels />
    </div>
  );
}

// --- Agent self-registration ------------------------------------------------

function EnrollPanel() {
  const toast = useToast();
  const { confirmDialog } = useModal();
  const { data, loading, error, reload } = useAsync(() =>
    api.get<GlobalEnroll>('/agents/enrollment/global'),
  );

  if (loading) {
    return (
      <div className="panel">
        <Loading label="Loading…" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="panel">
        <Empty>Failed to load enrollment settings.</Empty>
      </div>
    );
  }

  const g = data;

  const onToggle = async (checked: boolean) => {
    try {
      await api.patch('/agents/enrollment/global', { enabled: checked });
      toast(checked ? 'Self-registration enabled' : 'Self-registration disabled', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
    reload();
  };

  const copy = async (token: string) => {
    const ok = await copyToClipboard(token);
    toast(ok ? 'Token copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
  };

  const rotate = () =>
    confirmDialog(
      'Rotate global token',
      'The current token stops working for new rollouts. Agents already enrolled keep working.',
      async () => {
        await api.post('/agents/enrollment/global/rotate');
        toast('Token rotated', 'success');
        reload();
      },
    );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Agent self-registration</h2>
      </div>
      <div className="row">
        <div className="row-main">
          <div className="row-title">Global enrollment token</div>
          <div className="row-sub">
            When enabled, agents register themselves with this shared token — they choose their own
            name and exchange the token for their own credential.
          </div>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={g.enabled} onChange={(e) => void onToggle(e.target.checked)} />
          Enabled
        </label>
      </div>
      {g.enabled && g.token && (
        <div className="row">
          <div className="row-main" style={{ minWidth: 0 }}>
            <div className="row-title">Token</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <div className="mono" style={{ ...MONO_STYLE, flex: 1, minWidth: 0 }}>
                {g.token}
              </div>
              <button
                className="btn btn-ghost btn-sm"
                title="Copy token"
                onClick={() => void copy(g.token!)}
              >
                <Icon name="copy" />
              </button>
              <button className="btn btn-ghost btn-sm" title="Rotate token" onClick={rotate}>
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
  const { data, loading, error } = useAsync(() => api.get<SystemSettings>('/settings/system'));

  if (loading) {
    return (
      <>
        <div className="panel section-gap">
          <Loading label="Loading…" />
        </div>
        <div className="panel section-gap">
          <Loading label="Loading…" />
        </div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <div className="panel section-gap">
          <Empty>Failed to load system settings.</Empty>
        </div>
        <div className="panel section-gap">
          <Empty>Failed to load system settings.</Empty>
        </div>
      </>
    );
  }

  return (
    <>
      <AgentPanel sys={data} />
      <SsoPanel sys={data} />
    </>
  );
}

// --- Agent offline timeout --------------------------------------------------

function AgentPanel({ sys }: { sys: SystemSettings }) {
  const toast = useToast();
  const [value, setValue] = useState(String(sys.agentOfflineTimeoutSeconds));

  const save = async () => {
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
      toast('Enter a whole number between 30 and 3600 seconds', 'error');
      return;
    }
    try {
      await api.patch('/settings/agents', { offlineTimeoutSeconds: seconds });
      toast('Agent settings saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>Agents</h2>
      </div>
      <div style={BODY_STYLE}>
        <Field
          label="Offline timeout (seconds)"
          help="After how long without a poll an agent is marked offline. 30–3600 seconds."
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
            Save
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
    toast(ok ? 'Redirect URI copied' : 'Copy failed — select and copy manually', ok ? 'success' : 'error');
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
      toast('SSO configuration saved', 'success');
      setEnabled(updated.sso.enabled);
      setRedirectUri(updated.ssoRedirectUri);
      setProviders(toDrafts(updated.sso.providers));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Error', 'error');
    }
  };

  return (
    <div className="panel section-gap">
      <div className="panel-head">
        <h2>Single sign-on</h2>
      </div>
      <div style={BODY_STYLE}>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable single sign-on
        </label>
        {enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="row" style={{ padding: 0 }}>
              <div className="row-main" style={{ minWidth: 0 }}>
                <div className="row-title">Redirect URI</div>
                <div className="row-sub">Register this callback URL with every provider.</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <div className="mono" style={{ ...MONO_STYLE, flex: 1, minWidth: 0 }}>
                    {redirectUri}
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Copy redirect URI"
                    onClick={() => void copyRedirect()}
                  >
                    <Icon name="copy" />
                  </button>
                </div>
              </div>
            </div>
            <div style={SUBHEAD_STYLE}>Providers</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {providers.length === 0 ? (
                <div className="row-sub" style={{ padding: '2px 0' }}>
                  No providers yet. Add one below.
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
                  Add provider
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
            Save SSO
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
  const meta = SSO_PROVIDER_META.find((m) => m.type === draft.type)!;
  return (
    <div style={CARD_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{meta.name}</div>
        <button className="btn btn-ghost btn-sm" title="Remove provider" onClick={onRemove}>
          <Icon name="trash" />
        </button>
      </div>
      {meta.issuer && (
        <Field label="Issuer URL" help="Base URL exposing /.well-known/openid-configuration.">
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
        <Field label="Directory (tenant) ID">
          <input
            className="input"
            type="text"
            value={draft.tenantId}
            placeholder="directory (tenant) id"
            onChange={(e) => onChange({ tenantId: e.target.value })}
          />
        </Field>
      )}
      <Field label="Client ID">
        <input
          className="input"
          type="text"
          value={draft.clientId}
          onChange={(e) => onChange({ clientId: e.target.value })}
        />
      </Field>
      <Field
        label="Client secret"
        help={draft.clientSecretSet ? 'A secret is stored. Leave blank to keep it.' : undefined}
      >
        <input
          className="input"
          type="password"
          placeholder={draft.clientSecretSet ? '•••••••• (unchanged)' : 'Client secret'}
          value={draft.clientSecret}
          onChange={(e) => onChange({ clientSecret: e.target.value })}
        />
      </Field>
      <Field label="Login button label (optional)" help={`Defaults to "${meta.name}".`}>
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
