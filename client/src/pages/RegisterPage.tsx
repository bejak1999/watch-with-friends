import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type User } from '../lib/api';
import { useApp } from '../state/AppState';
import { Brand, Field, Icon } from '../components/ui';

export function RegisterPage() {
  const { setUser, siteName } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [code, setCode] = useState(params.get('code') || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [codeState, setCodeState] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [codeReason, setCodeReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Validate the code as it is typed so people are not stuck guessing.
  useEffect(() => {
    const cleaned = code.replace(/[^a-zA-Z0-9]/g, '');
    if (cleaned.length < 8) {
      setCodeState('idle');
      return;
    }
    setCodeState('checking');
    const timer = setTimeout(() => {
      api
        .post<{ valid: boolean; reason?: string }>('/auth/check-code', { code })
        .then((res) => {
          setCodeState(res.valid ? 'valid' : 'invalid');
          setCodeReason(res.reason || '');
        })
        .catch(() => setCodeState('idle'));
    }, 350);
    return () => clearTimeout(timer);
  }, [code]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api.post<{ user: User }>('/auth/register', { code, username, password });
      setUser(data.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <Brand large name={siteName} />
        <div>
          <h1 style={{ fontSize: '1.35rem' }}>Create your account</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            You need a registration code from the server admin.
          </p>
        </div>

        {error && <div className="form-error">{error}</div>}

        <Field
          label="Registration code"
          hint={
            codeState === 'valid'
              ? '✓ This code works'
              : codeState === 'invalid'
                ? `✗ ${codeReason || 'Not a usable code'}`
                : undefined
          }
        >
          <div style={{ position: 'relative' }}>
            <input
              className="input mono"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX"
              style={{
                letterSpacing: '0.1em',
                borderColor:
                  codeState === 'valid'
                    ? 'var(--success)'
                    : codeState === 'invalid'
                      ? 'var(--danger)'
                      : undefined,
              }}
              required
            />
            {codeState === 'checking' && (
              <span className="spinner" style={{ position: 'absolute', right: 11, top: '50%', marginTop: -9 }} />
            )}
            {codeState === 'valid' && (
              <span style={{ position: 'absolute', right: 11, top: '50%', marginTop: -9, color: 'var(--success)' }}>
                <Icon name="check" size={17} />
              </span>
            )}
          </div>
        </Field>

        <Field label="Username" hint="3-24 characters. Letters, numbers, and _ . -">
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            minLength={3}
            maxLength={24}
            required
          />
        </Field>

        <Field label="Password" hint="At least 8 characters">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>

        <Field label="Repeat password">
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>

        <button className="btn primary block" type="submit" disabled={busy || codeState === 'invalid'}>
          {busy ? <span className="spinner" /> : 'Create account'}
        </button>

        <p className="small muted" style={{ textAlign: 'center' }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
