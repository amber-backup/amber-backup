import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAND_MARK_SRC } from '../core/icons';
import { api } from '../core/api';
import { useAuth } from '../core/auth';
import { passkeysSupported } from '../core/passkeys';
import { Field } from '../ui/primitives';

interface SsoProvider {
  id: string;
  label: string;
}

export function Login() {
  const { login, loginTotp, loginPasskey } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials');
  const [challengeToken, setChallengeToken] = useState('');
  const [code, setCode] = useState('');

  useEffect(() => {
    void api
      .get<SsoProvider[]>('/auth/providers')
      .then(setProviders)
      .catch(() => undefined);
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
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
      setBusy(false);
    }
  };

  const doTotp = async () => {
    setError(null);
    setBusy(true);
    try {
      await loginTotp(challengeToken, code.trim());
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
      setBusy(false);
    }
  };

  const doPasskey = async () => {
    setError(null);
    setBusy(true);
    try {
      await loginPasskey();
      navigate('/', { replace: true });
    } catch (e) {
      // A user dismissing the native passkey prompt isn't a real error.
      if (e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'NotAllowedError') {
        setBusy(false);
        return;
      }
      setError(e instanceof Error ? e.message : 'Passkey sign-in failed');
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

        {step === 'credentials' ? (
          <>
            <Field label="Email">
              <input
                type="email"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
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
              Sign in
            </button>

            {passkeysSupported() && (
              <button
                className="btn btn-ghost"
                style={{ width: '100%', justifyContent: 'center' }}
                disabled={busy}
                onClick={() => void doPasskey()}
              >
                Sign in with a passkey
              </button>
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
                    {`Sign in with ${p.label}`}
                  </a>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="Authentication code">
              <input
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
              Enter the 6-digit code from your authenticator app, or a recovery code.
            </div>
            <button
              className="btn btn-primary"
              style={{ width: '100%' }}
              disabled={busy}
              onClick={() => void doTotp()}
            >
              Verify
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
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
