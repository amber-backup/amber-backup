import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../core/api';
import { useAuth } from '../core/auth';
import { Icon } from '../core/icons';
import { fmtDateTime, fmtRelative } from '../core/format';
import { clearDeviceCode } from '../core/device-login';
import { useToast } from '../ui/toast';
import { BusyButton, Field, Loading, PageHeader } from '../ui/primitives';
import { useT } from '../i18n';

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
  { value: '30', label: 'days30' },
  { value: '90', label: 'days90' },
  { value: '365', label: 'year1' },
  { value: '', label: 'never' },
] as const;

/**
 * Approval screen for `ambb login`: the CLI shows a code and a link to this
 * page; the signed-in user reviews the request and issues the device an API
 * key with the chosen access and lifetime.
 */
export function DeviceLogin() {
  const t = useT();
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
          ? t.device.unknownCode
          : e instanceof Error
            ? e.message
            : t.device.lookupFailed,
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
      toast(e instanceof Error ? e.message : t.common.error, 'error');
    }
  };

  return (
    <div>
      <PageHeader title={t.device.title} subtitle={t.device.subtitle} />

      {phase.kind === 'loading' && <Loading label={t.device.lookingUp} />}

      {phase.kind === 'enter' && (
        <div className="panel device-panel">
          <div className="panel-head">
            <h2>{t.device.enter.title}</h2>
          </div>
          <form
            className="device-body"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(code);
            }}
          >
            {error && <div className="warn-box">{error}</div>}
            <Field label={t.device.enter.code} help={t.device.enter.codeHelp}>
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
                {t.device.enter.continue}
              </button>
            </div>
          </form>
        </div>
      )}

      {phase.kind === 'review' && (
        <div className="panel device-panel">
          <div className="panel-head">
            <h2>{t.device.review.title}</h2>
          </div>
          <div className="device-body">
            <div className="device-code mono">{code}</div>
            <div className="warn-box">
              {t.device.review.warningBefore}
              <span className="mono">ambb login</span>
              {t.device.review.warningMiddle}
              <strong>{user?.email}</strong>
              {t.device.review.warningAfter}
            </div>

            <div className="integrity-facts device-facts">
              <div className="integrity-fact">
                <div className="integrity-fact-label">{t.device.review.device}</div>
                <div className="integrity-fact-value">{phase.request.clientName}</div>
              </div>
              <div className="integrity-fact">
                <div className="integrity-fact-label">{t.device.review.requestedFrom}</div>
                <div className="integrity-fact-value mono">{phase.request.requestIp ?? t.device.review.unknown}</div>
                <div className="integrity-fact-sub device-ua">{phase.request.requestUserAgent ?? ''}</div>
              </div>
              <div className="integrity-fact">
                <div className="integrity-fact-label">{t.device.review.requested}</div>
                <div className="integrity-fact-value">{fmtRelative(phase.request.createdAt)}</div>
                <div className="integrity-fact-sub">{t.device.review.expires(fmtDateTime(phase.request.expiresAt))}</div>
              </div>
            </div>

            <Field
              label={t.device.review.access}
              help={access === 'read' ? t.device.review.readHelp : t.device.review.fullHelp}
            >
              <select value={access} onChange={(e) => setAccess(e.target.value as 'read' | 'full')}>
                <option value="read">{t.device.review.readOnly}</option>
                <option value="full">{t.device.review.fullAccess}</option>
              </select>
            </Field>
            <Field label={t.device.review.expiresAfter} help={t.device.review.expiresAfterHelp}>
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.label} value={o.value}>
                    {t.device.review[o.label]}
                  </option>
                ))}
              </select>
            </Field>

            <div className="device-actions">
              <BusyButton className="btn btn-ghost" onClick={() => decide(false, phase.request.clientName)}>
                {t.device.review.deny}
              </BusyButton>
              <BusyButton
                className="btn btn-primary"
                busyLabel={t.device.review.approving}
                onClick={() => decide(true, phase.request.clientName)}
              >
                {t.device.review.approve}
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
                  ? t.device.result.approvedTitle(phase.clientName)
                  : t.device.result.deniedTitle(phase.clientName)}
              </div>
              <div className="row-sub">
                {phase.kind === 'approved'
                  ? t.device.result.approvedHelp
                  : t.device.result.deniedHelp}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
