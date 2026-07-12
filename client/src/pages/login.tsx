import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAND_MARK_SRC } from '../core/icons';
import { api } from '../core/api';
import { useAuth } from '../core/auth';
import { Field } from '../ui/primitives';

interface SsoProvider {
  id: string;
  label: string;
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<SsoProvider[]>([]);

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
      await login(email, password);
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
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
          style={{ width: '100%' }}
          disabled={busy}
          onClick={() => void doLogin()}
        >
          Sign in
        </button>

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
      </div>
    </div>
  );
}
