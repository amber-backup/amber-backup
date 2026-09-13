import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAND_MARK_SRC } from '../core/icons';
import { api } from '../core/api';
import { useAuth } from '../core/auth';
import { passkeysSupported } from '../core/passkeys';
import { Field } from '../ui/primitives';
import { postLoginPath } from '../core/device-login';
import { messages, useT } from '../i18n';

interface SsoProvider {
  id: string;
  label: string;
}

/** Which ways in this instance offers, from the public discovery endpoint. */
interface LoginMethods {
  localLogin: boolean;
  providers: SsoProvider[];
}

/** Why a redirect back from an identity provider did not sign anyone in. */
function ssoMessage(reason: string): string {
  const m = messages().login.sso;
  const byReason: Record<string, string> = { pending: m.pending, local_account: m.localAccount };
  return byReason[reason] ?? m.incomplete;
}

export function Login() {
  const t = useT();
  const { login, loginTotp, loginPasskey } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [localLogin, setLocalLogin] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [code, setCode] = useState('');

  useEffect(() => {
    void api
      .get<LoginMethods>('/auth/providers')
      .then((m) => {
        setProviders(m.providers);
        setLocalLogin(m.localLogin);
      })
      .catch(() => undefined);
  }, []);

  // The SSO callback redirects here with a reason when it could not sign the
  // user in; the query sits before the hash route.
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('sso');
    if (!reason) return;
    setNotice(ssoMessage(reason));
    const url = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', url);
  }, []);

  const doLogin = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await login(email, password);
      if ('totpRequired' in res) {
        // Password accepted; a second factor is needed before a session is issued.
        setChallengeToken(res.challengeToken);
        setStep('totp');
        setCode('');
        setBusy(false);
        return;
      }
      navigate(postLoginPath(), { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : t.login.signInFailed);
      setBusy(false);
    }
  };

  const doTotp = async () => {
    setError(null);
    setBusy(true);
    try {
      await loginTotp(challengeToken, code.trim());
      navigate(postLoginPath(), { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : t.login.verificationFailed);
      setBusy(false);
    }
  };

  const doPasskey = async () => {
    setError(null);
    setBusy(true);
    try {
      await loginPasskey();
      navigate(postLoginPath(), { replace: true });
    } catch (e) {
      // A user dismissing the native passkey prompt isn't a real error.
      if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'NotAllowedError') {
        setBusy(false);
        return;
      }
      setError(e instanceof Error ? e.message : t.login.passkeyFailed);
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <img className="brand-mark" src={BRAND_MARK_SRC} width={28} height={28} alt="" />
          <div className="brand-name">
            Amber<span>Backup</span>
          </div>
        </div>

        {error && <div className="login-error">{error}</div>}
        {notice && !error && <div className="login-notice">{notice}</div>}

        {step === 'credentials' ? (
          <>
            {localLogin && (
              <>
                <Field label={t.login.email}>
                  <input
                    type="email"
                    placeholder="admin@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field label={t.login.password}>
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void doLogin();
                    }}
                  />
                </Field>
                <button
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', marginBottom: '15px' }}
                  disabled={busy}
                  onClick={() => void doLogin()}
                >
                  {t.login.signIn}
                </button>

                {passkeysSupported() && (
                  <button
                    className="btn btn-ghost"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={busy}
                    onClick={() => void doPasskey()}
                  >
                    {t.login.signInWithPasskey}
                  </button>
                )}
              </>
            )}

            {!localLogin && providers.length === 0 && (
              <div className="help" style={{ textAlign: 'center' }}>
                {t.login.noMethod}
              </div>
            )}

            {providers.length > 0 && (
              <div className="sso-list">
                {providers.map((p) => (
                  <a
                    key={p.id}
                    className="btn btn-ghost"
                    style={{ width: '100%', justifyContent: 'center' }}
                    href={`/api/auth/oidc/${p.id}`}
                  >
                    {t.login.signInWith(p.label)}
                  </a>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <Field label={t.login.codeLabel}>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doTotp();
                }}
              />
            </Field>
            <div className="help" style={{ marginTop: -4, marginBottom: 4 }}>
              {t.login.codeHelp}
            </div>
            <button
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', marginBottom: '15px' }}
              disabled={busy}
              onClick={() => void doTotp()}
            >
              {t.login.verify}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={busy}
              onClick={() => {
                setStep('credentials');
                setError(null);
                setCode('');
              }}
            >
              {t.login.back}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
