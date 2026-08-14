import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../state/AppState';
import { Brand } from '../components/ui';

interface InviteInfo {
  id: string;
  name: string;
  topic: string | null;
  ownerName: string | null;
}

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { siteName } = useApp();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .get<{ room: InviteInfo }>(`/rooms/invite/${token}`)
      .then((res) => setInfo(res.room))
      .catch((err) => setError(err instanceof Error ? err.message : 'Invite not found'));
  }, [token]);

  const accept = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const res = await api.post<{ roomId: string }>(`/rooms/invite/${token}/accept`);
      navigate(`/rooms/${res.roomId}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join');
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ textAlign: 'center', alignItems: 'center' }}>
        <Brand large name={siteName} />
        {error ? (
          <>
            <div className="form-error" style={{ width: '100%' }}>{error}</div>
            <button className="btn block" onClick={() => navigate('/')}>Back to rooms</button>
          </>
        ) : !info ? (
          <span className="spinner" />
        ) : (
          <>
            <div>
              <p className="muted small">You were invited to</p>
              <h1 style={{ marginTop: 6 }}>{info.name}</h1>
              {info.topic && <p className="muted small" style={{ marginTop: 6 }}>{info.topic}</p>}
              {info.ownerName && (
                <p className="faint tiny" style={{ marginTop: 8 }}>hosted by {info.ownerName}</p>
              )}
            </div>
            <button className="btn primary block" onClick={accept} disabled={busy}>
              {busy ? <span className="spinner" /> : 'Join the room'}
            </button>
            <button className="btn ghost block" onClick={() => navigate('/')}>Not now</button>
          </>
        )}
      </div>
    </div>
  );
}
