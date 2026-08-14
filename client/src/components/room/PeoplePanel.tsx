import { useState } from 'react';
import { api, type Member, type RoomSnapshot } from '../../lib/api';
import { useApp } from '../../state/AppState';
import { Avatar, CopyButton, Icon } from '../ui';
import { formatTime } from '../../lib/format';

interface Props {
  room: RoomSnapshot;
  members: Member[];
  myUserId: string;
  roomPosition: number;
  onChanged: () => void;
}

export function PeoplePanel({ room, members, myUserId, roomPosition, onChanged }: Props) {
  const { toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const inviteUrl = `${window.location.origin}/join/${room.inviteToken}`;

  const online = members.filter((m) => m.online && !m.banned);
  const offline = members.filter((m) => !m.online && !m.banned);
  const banned = members.filter((m) => m.banned);

  const act = async (fn: () => Promise<unknown>, userId: string, okMessage: string) => {
    setBusy(userId);
    try {
      await fn();
      toast(okMessage, 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That did not work', 'error');
    } finally {
      setBusy(null);
    }
  };

  const renderPerson = (m: Member) => {
    const drift = m.online && m.position != null ? m.position - roomPosition : null;
    const offBy = drift != null && Math.abs(drift) > 2 ? drift : null;

    return (
      <div className={`person${m.online ? '' : ' offline'}`} key={m.userId}>
        <div style={{ position: 'relative' }}>
          <Avatar name={m.displayName} color={m.avatarColor} />
          <span
            className="dot"
            style={{
              position: 'absolute',
              right: -1,
              bottom: -1,
              border: '2px solid var(--surface)',
              width: 10,
              height: 10,
              background: m.online ? 'var(--success)' : 'var(--text-faint)',
            }}
          />
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="truncate" style={{ fontWeight: 550, fontSize: '0.88rem' }}>
              {m.displayName}
            </span>
            {m.userId === myUserId && <span className="tiny faint">(you)</span>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {m.role !== 'member' && <span className="tag accent">{m.role}</span>}
            {m.buffering && <span className="tag">buffering…</span>}
            {offBy != null && !m.buffering && (
              <span className="tiny faint" title="Difference from the room clock">
                {offBy > 0 ? '+' : ''}
                {formatTime(Math.abs(offBy))} off
              </span>
            )}
          </div>
        </div>

        {room.permissions.canManage && m.userId !== myUserId && m.userId !== room.ownerId && (
          <div className="row" style={{ gap: 2 }}>
            {!m.banned && (
              <button
                className="btn ghost icon sm"
                title={m.role === 'host' ? 'Demote to member' : 'Make host'}
                disabled={busy === m.userId}
                onClick={() =>
                  act(
                    () =>
                      api.post(`/rooms/${room.id}/members/${m.userId}/role`, {
                        role: m.role === 'host' ? 'member' : 'host',
                      }),
                    m.userId,
                    m.role === 'host' ? `${m.displayName} is now a member` : `${m.displayName} is now a host`
                  )
                }
                style={{ color: m.role === 'host' ? 'var(--accent)' : undefined }}
              >
                <Icon name="star" size={14} />
              </button>
            )}
            {m.banned ? (
              <button
                className="btn sm"
                disabled={busy === m.userId}
                onClick={() =>
                  act(() => api.post(`/rooms/${room.id}/members/${m.userId}/unban`), m.userId, 'Unbanned')
                }
              >
                Unban
              </button>
            ) : (
              <button
                className="btn ghost icon sm danger"
                title="Remove from the room"
                disabled={busy === m.userId}
                onClick={() => {
                  const ban = confirm(
                    `Remove ${m.displayName} from the room?\n\nOK = remove and block re-joining.\nCancel = just remove (they can rejoin with the link).`
                  );
                  void act(
                    () => api.post(`/rooms/${room.id}/members/${m.userId}/kick`, { ban }),
                    m.userId,
                    `${m.displayName} was removed`
                  );
                }}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="side-body">
      <div className="scroll-y" style={{ padding: 8 }}>
        <div className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div className="row between" style={{ marginBottom: 8 }}>
            <span className="small" style={{ fontWeight: 600 }}>Invite link</span>
            <CopyButton value={inviteUrl} />
          </div>
          <div className="mono tiny faint" style={{ wordBreak: 'break-all' }}>{inviteUrl}</div>
          {room.permissions.canManage && (
            <button
              className="btn sm"
              style={{ marginTop: 10 }}
              onClick={() =>
                act(
                  () => api.post(`/rooms/${room.id}/reset-invite`),
                  'room',
                  'A new invite link was generated'
                )
              }
            >
              <Icon name="refresh" size={13} /> Generate a new link
            </button>
          )}
        </div>

        <div className="nav-section" style={{ padding: '6px 6px 4px' }}>
          Watching now — {online.length}
        </div>
        {online.map(renderPerson)}

        {offline.length > 0 && (
          <>
            <div className="nav-section" style={{ padding: '12px 6px 4px' }}>Offline — {offline.length}</div>
            {offline.map(renderPerson)}
          </>
        )}

        {banned.length > 0 && (
          <>
            <div className="nav-section" style={{ padding: '12px 6px 4px' }}>Blocked — {banned.length}</div>
            {banned.map(renderPerson)}
          </>
        )}
      </div>
    </div>
  );
}
