import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../core/api';
import { useAuth } from '../core/auth';
import { Icon } from '../core/icons';
import { fmtDateTime, fmtRelative } from '../core/format';
import { clearDeviceCode } from '../core/device-login';
import { useToast } from '../ui/toast';
import { BusyButton, Field, Loading, PageHeader } from '../ui/primitives';

interface DeviceRequest {
  clientName: string;
  requestIp: string | null;
  requestUserAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

type Phase =
  | { kind: 'enter' }
  | { kind: 'loading' }
  | { kind: 'review'; request: DeviceRequest }
  | { kind: 'approved'; clientName: string }
  | { kind: 'denied'; clientName: string };

/** `bcdfghjk` / `BCDF GHJK` → `BCDF-GHJK`; anything else is returned as typed. */
function formatCode(input: string): string {
  const raw = input.toUpperCase().replace(/[\s-]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : input.trim().toUpperCase();
}

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '', label: 'Never' },
];

/**
 * Approval screen for `ambb login`: the CLI shows a code and a link to this
 * page; the signed-in user reviews the request and issues the device an API
 * key with the chosen access and lifetime.
 */
export function DeviceLogin() {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [code, setCode] = useState(() => formatCode(params.get('code') ?? ''));
  const [phase, setPhase] = useState<Phase>({ kind: params.get('code') ? 'loading' : 'enter' });
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<'read' | 'full'>('read');
  const [expiry, setExpiry] = useState('90');

  // The link has done its job once this page is reached.
  useEffect(() => clearDeviceCode(), []);

  const lookup = async (value: string) => {
    const formatted = formatCode(value);
    setCode(formatted);
    setError(null);
    setPhase({ kind: 'loading' });
    try {
      const request = await api.get<DeviceRequest>(
        `/auth/device/requests/${encodeURIComponent(formatted)}`,
      );
      setParams({ code: formatted }, { replace: true });
      setPhase({ kind: 'review', request });
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? 'This code is unknown, expired or already used. Run ambb login again for a new one.'
          : e instanceof Error
            ? e.message
            : 'Lookup failed',
      );
      setPhase({ kind: 'enter' });
    }
  };

  useEffect(() => {
    const initial = params.get('code');
    if (initial) void lookup(initial);
    // Only the code the page was opened with is looked up automatically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (approve: boolean, clientName: string) => {
    try {
      if (approve) {
        await api.post('/auth/device/approve', {
          userCode: code,
          access,
          expiresInDays: expiry ? Number(expiry) : undefined,
        });
        setPhase({ kind: 'approved', clientName });
      } else {
        await api.post('/auth/device/deny', { userCode: code });
        setPhase({ kind: 'denied', clientName });
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    }
  };

  return (
    <div>
      <PageHeader title="Device login" subtitle="Sign in the Amber Backup CLI (ambb) on another device" />

      {phase.kind === 'loading' && <Loading label="Looking up the request…" />}

      {phase.kind === 'enter' && (
        <div className="panel device-panel">
          <div className="panel-head">
            <h2>Enter the code from your terminal</h2>
          </div>
          <form
            className="device-body"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(code);
            }}
          >
            {error && <div className="warn-box">{error}</div>}
            <Field label="Code" help="Shown by ambb login, e.g. BCDF-GHJK">
              <input
                type="text"
                className="mono device-code-input"
                autoComplete="off"
                spellCheck={false}
                maxLength={12}
                placeholder="XXXX-XXXX"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            <div>
              <button className="btn btn-primary" type="submit" disabled={!code.trim()}>
                Continue
              </button>
            </div>
          </form>
        </div>
      )}

      {phase.kind === 'review' && (
        <div className="panel device-panel">
          <div className="panel-head">
            <h2>Approve this device?</h2>
          </div>
          <div className="device-body">
            <div className="device-code mono">{code}</div>
            <div className="warn-box">
              Only continue if you started <span className="mono">ambb login</span> yourself just now
              and your terminal shows exactly this code. If someone sent you this link, deny it — approving
              gives that device access to Amber Backup as <strong>{user?.email}</strong>.
            </div>

            <div className="integrity-facts device-facts">
              <div className="integrity-fact">
                <div className="integrity-fact-label">Device</div>
                <div className="integrity-fact-value">{phase.request.clientName}</div>
              </div>
              <div className="integrity-fact">
                <div className="integrity-fact-label">Requested from</div>
                <div className="integrity-fact-value mono">{phase.request.requestIp ?? 'unknown'}</div>
                <div className="integrity-fact-sub device-ua">{phase.request.requestUserAgent ?? ''}</div>
              </div>
              <div className="integrity-fact">
                <div className="integrity-fact-label">Requested</div>
                <div className="integrity-fact-value">{fmtRelative(phase.request.createdAt)}</div>
                <div className="integrity-fact-sub">{`Expires ${fmtDateTime(phase.request.expiresAt)}`}</div>
              </div>
            </div>

            <Field
              label="Access"
              help={
                access === 'read'
                  ? 'The device can list and inspect, but not run jobs or change anything.'
                  : 'The device can do everything your account can, except administration.'
              }
            >
              <select value={access} onChange={(e) => setAccess(e.target.value as 'read' | 'full')}>
                <option value="read">Read-only</option>
                <option value="full">Full access</option>
              </select>
            </Field>
            <Field label="Key expires after" help="The device has to sign in again afterwards.">
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.label} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="device-actions">
              <BusyButton className="btn btn-ghost" onClick={() => decide(false, phase.request.clientName)}>
                Deny
              </BusyButton>
              <BusyButton
                className="btn btn-primary"
                busyLabel="Approving…"
                onClick={() => decide(true, phase.request.clientName)}
              >
                Approve
              </BusyButton>
            </div>
          </div>
        </div>
      )}

      {(phase.kind === 'approved' || phase.kind === 'denied') && (
        <div className="panel device-panel">
          <div className="row">
            <span
              className="stat-icon"
              style={{
                background: phase.kind === 'approved' ? 'var(--amber-glow)' : 'var(--danger-bg)',
                color: phase.kind === 'approved' ? 'var(--amber)' : 'var(--danger)',
              }}
            >
              <Icon name={phase.kind === 'approved' ? 'shield' : 'x'} size={16} />
            </span>
            <div className="row-main">
              <div className="row-title">
                {phase.kind === 'approved'
                  ? `${phase.clientName} is signed in`
                  : `Sign-in of ${phase.clientName} denied`}
              </div>
              <div className="row-sub">
                {phase.kind === 'approved'
                  ? 'The CLI finishes on its own within a few seconds. You can close this tab. The key is listed under Settings → API keys, where you can revoke it.'
                  : 'The CLI stops waiting. No key was issued.'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
