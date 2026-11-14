import { useState } from 'react';
import { api, ApiError } from '../core/api';
import { useAuth } from '../core/auth';
import { copyToClipboard } from '../core/clipboard';
import { Icon } from '../core/icons';
import { useT } from '../i18n';
import { ModalFrame } from './modal';
import { BusyButton } from './primitives';
import { useToast } from './toast';

/** Letters and digits without look-alikes (0/O, 1/l/I), so a copy typed by hand survives. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * A random repository password from the browser's CSPRNG. 32 characters of a
 * 57-symbol alphabet are ~186 bits. Rejection sampling keeps every symbol
 * equally likely.
 */
export function generateRepoPassword(length = 32): string {
  const limit = 256 - (256 % ALPHABET.length);
  const out: string[] = [];
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit) out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

/** A secret in a read-only field with show/hide and copy. */
export function SecretField({ value, initiallyVisible = false }: { value: string; initiallyVisible?: boolean }) {
  const t = useT();
  const m = t.jobs.password;
  const toast = useToast();
  const [visible, setVisible] = useState(initiallyVisible);
  return (
    <div className="secret-row">
      <input
        type={visible ? 'text' : 'password'}
        readOnly
        value={value}
        aria-label={t.jobs.editor.repository.password}
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setVisible((v) => !v)}>
        {visible ? m.hide : m.show}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          const ok = await copyToClipboard(value);
          toast(ok ? t.common.copied : t.runs.detail.copyFailed, ok ? 'success' : 'error');
        }}
      >
        <Icon name="copy" size={13} />
        {t.common.copy}
      </button>
    </div>
  );
}

/**
 * Shows a job's stored repository password to an admin. A user with a local
 * password confirms it first; SSO-only accounts have none to confirm. The
 * server records every reveal in the audit log.
 */
export function RevealPasswordModal({
  jobId,
  jobName,
  onClose,
}: {
  jobId: string;
  jobName: string;
  onClose: () => void;
}) {
  const t = useT();
  const m = t.jobs.password;
  const { user } = useAuth();
  const needsPassword = user?.auth_source === 'local';
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    if (needsPassword && !current) {
      setError(m.currentPasswordRequired);
      return;
    }
    setError(null);
    try {
      const res = await api.post<{ password: string }>(
        `/jobs/${jobId}/repository-password/reveal`,
        needsPassword ? { currentPassword: current } : {},
      );
      setPassword(res.password);
      setCurrent('');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) setError(m.wrongPassword);
      else if (e instanceof ApiError && e.status === 404) setError(m.unsupported);
      else setError(e instanceof Error ? e.message : m.revealFailed);
    }
  };

  return (
    <ModalFrame
      title={m.revealTitle(jobName)}
      onClose={onClose}
      guardChanges={false}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t.common.close}
          </button>
          {password === null && (
            <BusyButton className="btn btn-primary" onClick={reveal}>
              <Icon name="key" size={14} />
              {m.reveal}
            </BusyButton>
          )}
        </>
      }
    >
      <div className="dialog-stack">
        <div className="warn-callout">{m.revealIntro}</div>
        {password !== null ? (
          <SecretField value={password} initiallyVisible />
        ) : needsPassword ? (
          <div className="field">
            <label htmlFor="reveal-current-password">{m.currentPassword}</label>
            <input
              id="reveal-current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void reveal();
                }
              }}
            />
            <span className="help">{m.currentPasswordHelp}</span>
          </div>
        ) : (
          <div className="run-detail-note">{m.auditNote}</div>
        )}
        {error && <div className="danger-text" role="alert">{error}</div>}
      </div>
    </ModalFrame>
  );
}
