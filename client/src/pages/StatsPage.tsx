import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../state/AppState';
import { Avatar, EmptyState, Icon, Spinner } from '../components/ui';
import { relativeTime, sourceLabel } from '../lib/format';

interface DailyPoint {
  day: string;
  seconds: number;
}

interface PersonalStats {
  totalSeconds: number;
  rooms: number;
  videosAdded: number;
  messages: number;
  playlists: number;
  daily: DailyPoint[];
  perRoom: Array<{ roomId: string; name: string; seconds: number }>;
  sources: Array<{ source: string; count: number }>;
}

interface RoomStats {
  room: { id: string; name: string };
  totalSeconds: number;
  watchers: number;
  videosPlayed: number;
  messages: number;
  leaderboard: Array<{
    userId: string;
    displayName: string;
    avatarColor: string;
    avatarUrl: string | null;
    seconds: number;
  }>;
  daily: DailyPoint[];
  sources: Array<{ source: string; count: number }>;
  recent: Array<{ title: string; source: string; playedAt: number }>;
}

/** "4 h 12 min" reads better than 15120 s at every magnitude that matters. */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

/** A plain CSS bar chart - no chart library for fourteen numbers. */
function DailyChart({ data }: { data: DailyPoint[] }) {
  const peak = Math.max(1, ...data.map((d) => d.seconds));
  return (
    <div className="daily-chart" role="img" aria-label="Watch time over the last two weeks">
      {data.map((d) => {
        const label = new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, {
          weekday: 'short',
          day: 'numeric',
        });
        return (
          <div className="daily-col" key={d.day} title={`${label}: ${formatDuration(d.seconds)}`}>
            <div className="daily-bar-track">
              <div
                className="daily-bar"
                style={{ height: `${d.seconds === 0 ? 0 : Math.max(4, (d.seconds / peak) * 100)}%` }}
              />
            </div>
            <span className="daily-label">{label.split(' ')[0]}</span>
          </div>
        );
      })}
    </div>
  );
}

function SourceBreakdown({ sources }: { sources: Array<{ source: string; count: number }> }) {
  const total = sources.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return <div className="tiny faint">Nothing yet.</div>;
  return (
    <div className="col" style={{ gap: 6 }}>
      {sources.slice(0, 8).map((s) => (
        <div key={s.source} className="row" style={{ gap: 10 }}>
          <span className="small" style={{ width: 120, flex: 'none' }}>
            {sourceLabel(s.source)}
          </span>
          <div className="meter grow">
            <span style={{ width: `${(s.count / total) * 100}%` }} />
          </div>
          <span className="tiny faint" style={{ width: 34, textAlign: 'right' }}>
            {s.count}
          </span>
        </div>
      ))}
    </div>
  );
}

export function StatsPage() {
  const { user } = useApp();
  const [me, setMe] = useState<PersonalStats | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomStats | null>(null);

  useEffect(() => {
    api
      .get<PersonalStats>('/stats/me')
      .then((data) => {
        setMe(data);
        if (data.perRoom[0]) setRoomId(data.perRoom[0].roomId);
      })
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!roomId) return;
    setRoom(null);
    api
      .get<RoomStats>(`/stats/rooms/${roomId}`)
      .then(setRoom)
      .catch(() => setRoom(null));
  }, [roomId]);

  if (!me) return <Spinner label="Crunching numbers" />;

  const nothingYet = me.totalSeconds === 0 && me.videosAdded === 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Statistics</h1>
          <div className="sub">Watch time is counted on the server, and only while a video is actually playing.</div>
        </div>
      </div>

      {nothingYet ? (
        <EmptyState
          icon="📊"
          title="Nothing watched yet"
          hint="Numbers appear once you have watched something in a room."
          action={
            <Link className="btn primary" to="/" style={{ marginTop: 8 }}>
              <Icon name="home" size={15} /> Go to the rooms
            </Link>
          }
        />
      ) : (
        <>
          <section className="col">
            <h2>You</h2>
            <div className="stat-grid">
              <Stat value={formatDuration(me.totalSeconds)} label="Total watched" />
              <Stat value={me.videosAdded} label="Videos added" />
              <Stat value={me.messages} label="Messages sent" />
              <Stat value={me.rooms} label="Rooms watched in" />
              <Stat value={me.playlists} label="Playlists owned" />
            </div>
          </section>

          <section className="panel">
            <h2>Your last two weeks</h2>
            <DailyChart data={me.daily} />
          </section>

          {me.sources.length > 0 && (
            <section className="panel">
              <h2>What you add</h2>
              <SourceBreakdown sources={me.sources} />
            </section>
          )}

          {me.perRoom.length > 0 && (
            <section className="panel">
              <h2>Your rooms</h2>
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Room</th>
                      <th style={{ textAlign: 'right' }}>You watched</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {me.perRoom.map((r) => (
                      <tr key={r.roomId}>
                        <td style={{ fontWeight: 550 }}>{r.name}</td>
                        <td style={{ textAlign: 'right' }}>{formatDuration(r.seconds)}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            className={`btn sm${roomId === r.roomId ? ' primary' : ''}`}
                            onClick={() => setRoomId(r.roomId)}
                          >
                            Room stats
                          </button>
                          <Link className="btn ghost sm" to={`/rooms/${r.roomId}`}>
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {roomId && (
            <section className="col">
              <h2>{room ? room.room.name : 'Room'}</h2>
              {!room ? (
                <Spinner />
              ) : (
                <>
                  <div className="stat-grid">
                    <Stat value={formatDuration(room.totalSeconds)} label="Watched together" />
                    <Stat value={room.videosPlayed} label="Videos played" />
                    <Stat value={room.watchers} label="People" />
                    <Stat value={room.messages} label="Chat messages" />
                  </div>

                  <div className="panel">
                    <h3>Who watched the most</h3>
                    {room.leaderboard.length === 0 ? (
                      <div className="tiny faint">Nothing yet.</div>
                    ) : (
                      <div className="col" style={{ gap: 8 }}>
                        {room.leaderboard.map((entry, i) => {
                          const top = room.leaderboard[0].seconds || 1;
                          return (
                            <div className="row" style={{ gap: 10 }} key={entry.userId}>
                              <span className="tiny faint" style={{ width: 16 }}>
                                {i + 1}
                              </span>
                              <Avatar
                                name={entry.displayName}
                                color={entry.avatarColor}
                                url={entry.avatarUrl}
                                size="sm"
                              />
                              <span className="small truncate" style={{ width: 130 }}>
                                {entry.displayName}
                                {entry.userId === user?.id ? ' (you)' : ''}
                              </span>
                              <div className="meter grow">
                                <span style={{ width: `${(entry.seconds / top) * 100}%` }} />
                              </div>
                              <span className="tiny faint" style={{ width: 74, textAlign: 'right' }}>
                                {formatDuration(entry.seconds)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="panel">
                    <h3>Room activity</h3>
                    <DailyChart data={room.daily} />
                  </div>

                  <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div className="panel grow" style={{ minWidth: 260 }}>
                      <h3>Where it came from</h3>
                      <SourceBreakdown sources={room.sources} />
                    </div>
                    <div className="panel grow" style={{ minWidth: 260 }}>
                      <h3>Recently played</h3>
                      {room.recent.length === 0 ? (
                        <div className="tiny faint">Nothing yet.</div>
                      ) : (
                        <div className="col" style={{ gap: 4 }}>
                          {room.recent.map((r, i) => (
                            <div className="row between" key={i} style={{ gap: 10 }}>
                              <span className="small truncate">{r.title}</span>
                              <span className="tiny faint" style={{ whiteSpace: 'nowrap' }}>
                                {relativeTime(r.playedAt)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
