import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, type User } from '../lib/api';
import { useApp } from '../state/AppState';
import { Brand, Field } from '../components/ui';
import { formatCooldown, useCooldown } from '../hooks/useCooldown';

export function LoginPage() {
  const { setUser, siteName, registrationOpen } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cooldown = useCooldown();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cooldown.active) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.post<{ user: User }>('/auth/login', { username, password });
      cooldown.clear();
      setUser(data.user);
      const next = params.get('next');
      navigate(next && next.startsWith('/') ? next : '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        cooldown.start(err.retryAfter);
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Sign in failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <Brand large name={siteName} />
        <div>
          <h1 style={{ fontSize: '1.35rem' }}>Welcome back</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            Sign in to jump back into your rooms.
          </p>
        </div>

        {error && !cooldown.active && <div className="form-error">{error}</div>}

        {cooldown.active && (
          <div className="form-error">
            <div style={{ fontWeight: 650 }}>Too many failed attempts</div>
            <div style={{ marginTop: 3 }}>
              Try again in <strong className="mono">{formatCooldown(cooldown.remaining)}</strong>. Each further
              wrong password doubles the wait.
            </div>
          </div>
        )}

        <Field label="Username">
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </Field>

        <Field label="Password">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <button className="btn primary block" type="submit" disabled={busy || cooldown.active}>
          {busy ? (
            <span className="spinner" />
          ) : cooldown.active ? (
            `Locked — ${formatCooldown(cooldown.remaining)}`
          ) : (
            'Sign in'
          )}
        </button>

        {registrationOpen && (
          <p className="small muted" style={{ textAlign: 'center' }}>
            Got a registration code? <Link to="/register">Create an account</Link>
          </p>
        )}
      </form>
    </div>
  );
}
