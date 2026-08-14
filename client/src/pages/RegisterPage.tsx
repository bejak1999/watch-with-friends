import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, type User } from '../lib/api';
import { useApp } from '../state/AppState';
import { Brand, Field, Icon } from '../components/ui';
import { formatCooldown, useCooldown } from '../hooks/useCooldown';

/** Codes are always 12 characters once separators are stripped. */
const CODE_LENGTH = 12;

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
  const cooldown = useCooldown();

  // Only check once a whole code has been entered. Validating half-typed codes
  // would spend the server's back-off budget on the user's own keystrokes.
  useEffect(() => {
    const cleaned = code.replace(/[^a-zA-Z0-9]/g, '');
    if (cleaned.length !== CODE_LENGTH) {
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
        .catch((err) => {
          if (err instanceof ApiError && err.status === 429) {
            cooldown.start(err.retryAfter);
            setError(err.message);
          }
          setCodeState('idle');
        });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cooldown.active) return;
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api.post<{ user: User }>('/auth/register', { code, username, password });
      cooldown.clear();
      setUser(data.user);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        cooldown.start(err.retryAfter);
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Registration failed');
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
          <h1 style={{ fontSize: '1.35rem' }}>Create your account</h1>
          <p className="muted small" style={{ marginTop: 4 }}>
            You need a registration code from the server admin.
          </p>
        </div>

        {error && !cooldown.active && <div className="form-error">{error}</div>}

        {cooldown.active && (
          <div className="form-error">
            <div style={{ fontWeight: 650 }}>Too many attempts with a bad code</div>
            <div style={{ marginTop: 3 }}>
              Try again in <strong className="mono">{formatCooldown(cooldown.remaining)}</strong>.
            </div>
          </div>
        )}

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

        <button
          className="btn primary block"
          type="submit"
          disabled={busy || codeState === 'invalid' || cooldown.active}
        >
          {busy ? (
            <span className="spinner" />
          ) : cooldown.active ? (
            `Locked — ${formatCooldown(cooldown.remaining)}`
          ) : (
            'Create account'
          )}
        </button>

        <p className="small muted" style={{ textAlign: 'center' }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
