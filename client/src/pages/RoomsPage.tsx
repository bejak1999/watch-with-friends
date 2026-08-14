import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type RoomSummary } from '../lib/api';
import { useApp } from '../state/AppState';
import { EmptyState, Field, Icon, Modal, Spinner, Toggle } from '../components/ui';
import { relativeTime } from '../lib/format';

export function RoomsPage() {
  const { user, toast } = useApp();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ rooms: RoomSummary[] }>('/rooms');
      setRooms(data.rooms);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load rooms', 'error');
      setRooms([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [load]);

  const visible = (rooms ?? []).filter((r) =>
    filter ? (r.name + (r.topic ?? '') + (r.ownerName ?? '')).toLowerCase().includes(filter.toLowerCase()) : true
  );
  const mine = visible.filter((r) => r.myRole);
  const discover = visible.filter((r) => !r.myRole);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Rooms</h1>
          <div className="sub">Start a watch party or hop into one that is already running.</div>
        </div>
        <div className="row">
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 11, top: '50%', marginTop: -8, color: 'var(--text-faint)' }}>
              <Icon name="search" size={15} />
            </span>
            <input
              className="input"
              placeholder="Search rooms"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ paddingLeft: 32, width: 200 }}
            />
          </div>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New room
          </button>
        </div>
      </div>

      {rooms === null ? (
        <Spinner label="Loading rooms" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="🍿"
          title={filter ? 'No rooms match that search' : 'No rooms yet'}
          hint={filter ? undefined : 'Create your first room and send the invite link to your friends.'}
          action={
            !filter ? (
              <button className="btn primary" onClick={() => setCreating(true)} style={{ marginTop: 8 }}>
                <Icon name="plus" size={16} /> Create a room
              </button>
            ) : undefined
          }
        />
      ) : (
        <>
          {mine.length > 0 && (
            <section className="col">
              <h2>Your rooms</h2>
              <div className="room-grid">
                {mine.map((room) => (
                  <RoomCard key={room.id} room={room} isOwner={room.ownerId === user?.id} />
                ))}
              </div>
            </section>
          )}
          {discover.length > 0 && (
            <section className="col">
              <h2>Public rooms</h2>
              <div className="room-grid">
                {discover.map((room) => (
                  <RoomCard key={room.id} room={room} isOwner={false} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {creating && (
        <CreateRoomModal
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/rooms/${id}`)}
        />
      )}
    </div>
  );
}

function RoomCard({ room, isOwner }: { room: RoomSummary; isOwner: boolean }) {
  return (
    <Link className="room-card" to={`/rooms/${room.id}`}>
      <div className="room-thumb">
        {room.thumbnail ? (
          <img src={room.thumbnail} alt="" loading="lazy" />
        ) : (
          <span className="placeholder">🎬</span>
        )}
        <div className="overlay">
          <span className="pill">
            <span className={`dot${room.onlineCount > 0 ? '' : ' off'}`} />
            {room.onlineCount > 0 ? `${room.onlineCount} watching` : 'idle'}
          </span>
          {room.queueCount > 0 && <span className="pill">{room.queueCount} in queue</span>}
        </div>
      </div>
      <div className="room-card-body">
        <div className="row between" style={{ gap: 8 }}>
          <div className="truncate" style={{ fontWeight: 650 }}>{room.name}</div>
          <span className="tag" title={room.isPublic ? 'Anyone signed in can join' : 'Invite only'}>
            <Icon name={room.isPublic ? 'globe' : 'lock'} size={11} />
          </span>
        </div>
        <div className="tiny faint truncate">
          {room.nowPlaying ? `▶ ${room.nowPlaying}` : room.topic || 'Nothing playing'}
        </div>
        <div className="row" style={{ gap: 6, marginTop: 2 }}>
          {isOwner && <span className="tag accent">Owner</span>}
          {!isOwner && room.myRole === 'host' && <span className="tag accent">Host</span>}
          <span className="tiny faint">{room.memberCount} member{room.memberCount === 1 ? '' : 's'}</span>
          <span className="tiny faint">· {relativeTime(room.updatedAt)}</span>
        </div>
      </div>
    </Link>
  );
}

function CreateRoomModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [hostsOnly, setHostsOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<{ room: { id: string } }>('/rooms', {
        name: name.trim(),
        topic: topic.trim() || undefined,
        isPublic,
        controlMode: hostsOnly ? 'hosts' : 'everyone',
        queueMode: hostsOnly ? 'hosts' : 'everyone',
      });
      onCreated(res.room.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the room', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New room"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? <span className="spinner" /> : 'Create room'}
          </button>
        </>
      }
    >
      <Field label="Room name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Friday movie night"
          maxLength={60}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
      </Field>
      <Field label="Topic" hint="Optional - shown on the room card">
        <input
          className="input"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Horror marathon 🎃"
          maxLength={200}
        />
      </Field>
      <div>
        <Toggle
          checked={isPublic}
          onChange={setIsPublic}
          label="Listed publicly"
          hint="Everyone with an account can find and join. Otherwise only the invite link works."
        />
        <Toggle
          checked={hostsOnly}
          onChange={setHostsOnly}
          label="Hosts control playback"
          hint="Only you and people you promote can play, pause, seek and change the queue."
        />
      </div>
    </Modal>
  );
}
