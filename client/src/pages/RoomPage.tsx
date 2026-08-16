import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../state/AppState';
import { useRoom } from '../hooks/useRoom';
import { SyncPlayer, expectedPosition, type SyncPlayerHandle } from '../components/player/SyncPlayer';
import type { QualityOption } from '../components/player/adapters';
import { QueuePanel } from '../components/room/QueuePanel';
import { ChatPanel } from '../components/room/ChatPanel';
import { PeoplePanel } from '../components/room/PeoplePanel';
import { AddMediaDialog } from '../components/room/AddMediaDialog';
import { RoomSettingsDialog } from '../components/room/RoomSettingsDialog';
import { CopyButton, Icon, Spinner } from '../components/ui';
import { formatTime, sourceLabel } from '../lib/format';
import type { MediaItem, Member, PlaybackState, QueueItem, RoomSnapshot } from '../lib/api';

type Tab = 'queue' | 'chat' | 'people';

export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user, toast } = useApp();

  const {
    status,
    error,
    connected,
    room,
    queue,
    messages,
    members,
    playback,
    serverOffset,
    waitingForBuffer,
    typingUsers,
    currentItem,
    actions,
  } = useRoom(roomId);

  const playerRef = useRef<SyncPlayerHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [tab, setTab] = useState<Tab>('queue');
  const [armed, setArmed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('wwf.volume') ?? 0.8));
  const [muted, setMuted] = useState(() => localStorage.getItem('wwf.muted') === '1');
  const [localTime, setLocalTime] = useState(0);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [theater, setTheater] = useState(false);
  const [unread, setUnread] = useState(0);
  const [playerFailed, setPlayerFailed] = useState(false);
  const [qualities, setQualities] = useState<QualityOption[]>([]);
  const [quality, setQuality] = useState('auto');
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(() => localStorage.getItem('wwf.captions') === '1');
  // Collapsing the side panel is remembered per device.
  const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem('wwf.sideCollapsed') === '1');
  const [debugOpen, setDebugOpen] = useState(false);

  const canControl = room?.permissions.canControl ?? false;
  const canQueue = room?.permissions.canQueue ?? false;
  const duration = currentItem?.duration || playerRef.current?.getDuration() || 0;

  useEffect(() => localStorage.setItem('wwf.volume', String(volume)), [volume]);
  useEffect(() => localStorage.setItem('wwf.muted', muted ? '1' : '0'), [muted]);
  useEffect(() => localStorage.setItem('wwf.captions', captionsOn ? '1' : '0'), [captionsOn]);
  useEffect(() => localStorage.setItem('wwf.sideCollapsed', sideCollapsed ? '1' : '0'), [sideCollapsed]);

  /* Track the player clock for the scrub bar. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      // Position 0 is a real position, so ask whether the player is loaded
      // rather than treating a falsy time as "no reading yet".
      const player = playerRef.current;
      setLocalTime(player?.isReady() ? player.getTime() : expectedPosition(playback, serverOffset));
    }, 250);
    return () => window.clearInterval(timer);
  }, [playback, serverOffset]);

  /* Unread chat badge while another tab is open. */
  useEffect(() => {
    if (tab === 'chat') setUnread(0);
  }, [tab, messages.length]);

  useEffect(() => {
    if (tab !== 'chat' && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.kind === 'chat' && last.userId !== user?.id) setUnread((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  /* Keyboard shortcuts. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          if (canControl) togglePlay();
          break;
        case 'arrowright':
          if (canControl) actions.seek(currentPosition() + (e.shiftKey ? 30 : 5));
          break;
        case 'arrowleft':
          if (canControl) actions.seek(Math.max(0, currentPosition() - (e.shiftKey ? 30 : 5)));
          break;
        case 'n':
          if (canControl) actions.next();
          break;
        case 'm':
          setMuted((m) => !m);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 't':
          setTheater((v) => !v);
          break;
        case 'c':
          if (captionsAvailable) setCaptionsOn((v) => !v);
          break;
        case 'd':
          setDebugOpen((v) => !v);
          break;
        case 'b':
          setSideCollapsed((v) => !v);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canControl, playback, serverOffset, captionsAvailable]);

  const currentPosition = () => {
    const player = playerRef.current;
    return player?.isReady() ? player.getTime() : expectedPosition(playback, serverOffset);
  };

  const togglePlay = () => {
    if (!canControl) {
      toast('Only hosts can control playback in this room', 'error');
      return;
    }
    setArmed(true);
    if (playback.isPlaying) actions.pause(currentPosition());
    else actions.play(currentPosition());
  };

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  const onAdd = useCallback(
    (items: MediaItem[], atTop?: boolean) => {
      actions.addToQueue(items, atTop);
      setAdding(false);
    },
    [actions]
  );

  const onBuffering = useCallback((b: boolean) => actions.reportBuffering(b), [actions]);
  const onReport = useCallback((p: number) => actions.reportPosition(p), [actions]);
  const onDuration = useCallback((itemId: string, s: number) => actions.reportDuration(itemId, s), [actions]);
  const onEnded = useCallback((itemId: string) => actions.reportEnded(itemId), [actions]);
  const onQualities = useCallback((options: QualityOption[], activeId: string) => {
    setQualities(options);
    setQuality(activeId);
  }, []);

  const changeQuality = useCallback((id: string) => {
    setQuality(id);
    playerRef.current?.setQuality(id);
  }, []);

  /**
   * A browser extension moved our playhead. Rather than fight it every 400ms,
   * carry the whole room to the new position - one person's SponsorBlock then
   * skips the sponsor for everybody.
   */
  const onExternalSeek = useCallback(
    (position: number) => {
      actions.seek(position);
    },
    [actions]
  );

  const onNotice = useCallback((message: string) => toast(message, 'info'), [toast]);

  const onPlayerError = useCallback(
    (message: string) => {
      setPlayerFailed(true);
      toast(message, 'error');
    },
    [toast]
  );

  /* A new track gets a clean slate. */
  useEffect(() => setPlayerFailed(false), [playback.currentItemId]);

  if (status === 'connecting') return <Spinner label="Joining the room" />;

  if (status === 'error' || status === 'kicked' || !room) {
    return (
      <div className="page">
        <div className="panel" style={{ maxWidth: 460, margin: '60px auto', textAlign: 'center' }}>
          <div style={{ fontSize: '2rem' }}>🚪</div>
          <h2>{status === 'kicked' ? 'You left this room' : 'Cannot open this room'}</h2>
          <p className="muted small">{error || 'The room may have been deleted.'}</p>
          <button className="btn primary" onClick={() => navigate('/')}>Back to rooms</button>
        </div>
      </div>
    );
  }

  const displayPosition = scrubbing ?? localTime;
  const progress = duration > 0 ? Math.min(100, (displayPosition / duration) * 100) : 0;

  return (
    <div
      className="room-layout"
      style={theater || sideCollapsed ? { gridTemplateColumns: '1fr' } : undefined}
    >
      <div className="stage-col">
        <div className={`stage${theater ? ' theater' : ''}`} ref={stageRef}>
          <SyncPlayer
            ref={playerRef}
            item={currentItem}
            playback={playback}
            serverOffset={serverOffset}
            armed={armed}
            volume={volume}
            muted={muted}
            onEnded={onEnded}
            onBuffering={onBuffering}
            onDuration={onDuration}
            onError={onPlayerError}
            onReport={onReport}
            onQualities={onQualities}
            onCaptionsAvailable={setCaptionsAvailable}
            captionsOn={captionsOn}
            canControl={canControl}
            onExternalSeek={onExternalSeek}
            onNotice={onNotice}
          />

          {/* Keeps clicks from reaching the embedded player so the room stays authoritative. */}
          <div className="click-shield" onClick={togglePlay} onDoubleClick={toggleFullscreen} />

          {!currentItem && (
            <div className="stage-overlay">
              <div className="inner">
                <div style={{ fontSize: '2.2rem' }}>🎬</div>
                <h2>Nothing queued yet</h2>
                <p className="muted small">Add a YouTube link, a Twitch stream, or one of your own files.</p>
                {canQueue && (
                  <button className="btn primary" onClick={() => setAdding(true)}>
                    <Icon name="plus" size={16} /> Add media
                  </button>
                )}
              </div>
            </div>
          )}

          {currentItem && !armed && !playerFailed && (
            <div className="stage-overlay">
              <div className="inner">
                <div style={{ fontSize: '2.2rem' }}>🍿</div>
                <h2>Ready when you are</h2>
                <p className="muted small">
                  Browsers block sound until you interact with the page. Tap to join the room's playback.
                </p>
                <button className="btn primary" onClick={() => setArmed(true)}>
                  <Icon name="play" size={16} /> Join playback
                </button>
              </div>
            </div>
          )}

          {waitingForBuffer && armed && (
            <div
              className="pill"
              style={{ position: 'absolute', top: 12, left: 12, zIndex: 6, height: 26 }}
            >
              <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
              Waiting for everyone…
            </div>
          )}

          {!connected && (
            <div className="pill" style={{ position: 'absolute', top: 12, right: 12, zIndex: 6, height: 26 }}>
              <span className="dot off" /> Reconnecting…
            </div>
          )}
        </div>

        {/* ---- controls ---- */}
        <div className="controls">
          <Scrubber
            progress={progress}
            duration={duration}
            disabled={!canControl || duration <= 0}
            onScrub={(seconds) => setScrubbing(seconds)}
            onCommit={(seconds) => {
              setScrubbing(null);
              actions.seek(seconds);
            }}
          />

          <div className="row between control-row" style={{ gap: 10 }}>
            <div className="row transport" style={{ gap: 2 }}>
              <button className="btn ghost icon" onClick={() => actions.prev()} disabled={!canControl} title="Previous">
                <Icon name="prev" size={17} />
              </button>
              <button
                className="btn primary icon"
                onClick={togglePlay}
                disabled={!canControl && !currentItem}
                title={playback.isPlaying ? 'Pause (space)' : 'Play (space)'}
              >
                <Icon name={playback.isPlaying ? 'pause' : 'play'} size={17} />
              </button>
              <button className="btn ghost icon" onClick={() => actions.next()} disabled={!canControl} title="Next (n)">
                <Icon name="next" size={17} />
              </button>

              <span className="mono tiny faint" style={{ marginLeft: 8, whiteSpace: 'nowrap' }}>
                {formatTime(displayPosition)} / {formatTime(duration)}
              </span>
            </div>

            <div className="now-playing grow" style={{ justifyContent: 'center' }}>
              {currentItem && (
                <>
                  <span className="truncate small" style={{ fontWeight: 550, maxWidth: 320 }}>
                    {currentItem.title}
                  </span>
                  <span className="tag">{sourceLabel(currentItem.source)}</span>
                </>
              )}
            </div>

            <div className="row secondary-controls" style={{ gap: 4 }}>
              <button className="btn ghost icon" onClick={() => setMuted((m) => !m)} title="Mute (m)">
                <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={17} />
              </button>
              <input
                className="volume"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  if (muted) setMuted(false);
                }}
                aria-label="Volume"
              />
              {canControl && (
                <select
                  className="select"
                  style={{ width: 74, height: 32 }}
                  value={playback.rate}
                  onChange={(e) => actions.setRate(Number(e.target.value))}
                  title="Playback speed"
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                    <option key={r} value={r}>{r}×</option>
                  ))}
                </select>
              )}
              {qualities.length > 1 && (
                <select
                  className="select"
                  style={{ width: 86, height: 32 }}
                  value={quality}
                  onChange={(e) => changeQuality(e.target.value)}
                  title={
                    currentItem?.source === 'youtube'
                      ? 'Resolution (YouTube treats this as a hint and may override it)'
                      : 'Resolution - only affects your own screen'
                  }
                >
                  {qualities.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.label}
                    </option>
                  ))}
                </select>
              )}
              {captionsAvailable && (
                <button
                  className="btn ghost icon"
                  onClick={() => setCaptionsOn((v) => !v)}
                  title={captionsOn ? 'Turn subtitles off (c)' : 'Turn subtitles on (c)'}
                  aria-pressed={captionsOn}
                  style={captionsOn ? { color: 'var(--accent)' } : undefined}
                >
                  <Icon name="captions" size={16} />
                </button>
              )}
              <button
                className="btn ghost icon hide-sm"
                onClick={() => setSideCollapsed((v) => !v)}
                title={sideCollapsed ? 'Show the side panel (b)' : 'Hide the side panel (b)'}
                style={sideCollapsed ? { color: 'var(--accent)' } : undefined}
              >
                <Icon name="panel-right" size={16} />
              </button>
              <button
                className="btn ghost icon hide-sm"
                onClick={() => setDebugOpen((v) => !v)}
                title="Diagnostics (d)"
                style={debugOpen ? { color: 'var(--accent)' } : undefined}
              >
                <Icon name="bug" size={16} />
              </button>
              <button
                className="btn ghost icon hide-sm"
                onClick={() => setTheater((v) => !v)}
                title="Theater mode (t)"
              >
                <Icon name={theater ? 'collapse' : 'expand'} size={16} />
              </button>
              <button className="btn ghost icon" onClick={toggleFullscreen} title="Fullscreen (f)">
                <Icon name="expand" size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* ---- room header ---- */}
        <div className="row between room-header" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="room-title-block">
            {/* min-width:0 all the way down, or the h2 refuses to truncate. */}
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <h2 className="truncate" style={{ minWidth: 0 }}>{room.name}</h2>
              <span className="tag">
                <Icon name={room.isPublic ? 'globe' : 'lock'} size={11} />
                {room.isPublic ? 'Public' : 'Invite only'}
              </span>
              {room.myRole && room.myRole !== 'member' && <span className="tag accent">{room.myRole}</span>}
            </div>
            {room.topic && <div className="tiny faint truncate">{room.topic}</div>}
          </div>
          <div className="row room-header-actions" style={{ gap: 6 }}>
            <CopyButton value={`${window.location.origin}/join/${room.inviteToken}`} label="Invite link" />
            {room.permissions.canManage && (
              <button className="btn sm" onClick={() => setSettingsOpen(true)}>
                <Icon name="settings" size={14} /> Settings
              </button>
            )}
            <button className="btn sm" onClick={() => navigate('/')}>Leave</button>
          </div>
        </div>
      </div>

      {!theater && !sideCollapsed && (
        <aside className="side">
          <div className="tabs" role="tablist">
            <button className="tab" role="tab" aria-selected={tab === 'queue'} onClick={() => setTab('queue')}>
              <Icon name="list" size={14} /> Queue <span className="count">{queue.length}</span>
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
              <Icon name="chat" size={14} /> Chat
              {unread > 0 && <span className="count">{unread}</span>}
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'people'} onClick={() => setTab('people')}>
              <Icon name="users" size={14} /> People{' '}
              <span className="count">{members.filter((m) => m.online).length}</span>
            </button>
          </div>

          {tab === 'queue' && (
            <QueuePanel
              roomId={room.id}
              queue={queue}
              currentItemId={playback.currentItemId}
              canQueue={canQueue}
              canControl={canControl}
              repeatMode={playback.repeatMode}
              actions={actions}
              onAddClick={() => setAdding(true)}
            />
          )}
          {tab === 'chat' && (
            <ChatPanel messages={messages} typingUsers={typingUsers} myUserId={user!.id} actions={actions} />
          )}
          {tab === 'people' && (
            <PeoplePanel
              room={room}
              members={members}
              myUserId={user!.id}
              roomPosition={expectedPosition(playback, serverOffset)}
              onChanged={() => undefined}
            />
          )}
        </aside>
      )}

      {debugOpen && (
        <DebugPanel
          onClose={() => setDebugOpen(false)}
          room={room}
          playback={playback}
          serverOffset={serverOffset}
          connected={connected}
          members={members}
          currentItem={currentItem}
          waitingForBuffer={waitingForBuffer}
          player={playerRef}
        />
      )}

      {adding && <AddMediaDialog roomId={room.id} onClose={() => setAdding(false)} onAdd={onAdd} />}
      {settingsOpen && (
        <RoomSettingsDialog room={room} onClose={() => setSettingsOpen(false)} onSaved={() => undefined} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Scrubber                                                          */
/* ---------------------------------------------------------------- */

function Scrubber({
  progress,
  duration,
  disabled,
  onScrub,
  onCommit,
}: {
  progress: number;
  duration: number;
  disabled: boolean;
  onScrub: (seconds: number) => void;
  onCommit: (seconds: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const positionFrom = (clientX: number) => {
    const el = ref.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onScrub(positionFrom(e.clientX));
    const up = (e: PointerEvent) => {
      setDragging(false);
      onCommit(positionFrom(e.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, duration]);

  return (
    <div
      ref={ref}
      className={`scrub${dragging ? ' dragging' : ''}${disabled ? ' disabled' : ''}`}
      onPointerDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
        onScrub(positionFrom(e.clientX));
      }}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round((progress / 100) * duration)}
      tabIndex={disabled ? -1 : 0}
    >
      <div className="track">
        <div className="fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="knob" style={{ left: `${progress}%` }} />
    </div>
  );
}


/* ---------------------------------------------------------------- */
/* Diagnostics                                                       */
/* ---------------------------------------------------------------- */

/**
 * Everything needed to explain "it went out of sync" without guessing:
 * the room's view, this player's view, and the gap between them.
 */
function DebugPanel({
  onClose,
  room,
  playback,
  serverOffset,
  connected,
  members,
  currentItem,
  waitingForBuffer,
  player,
}: {
  onClose: () => void;
  room: RoomSnapshot;
  playback: PlaybackState;
  serverOffset: number;
  connected: boolean;
  members: Member[];
  currentItem: QueueItem | null;
  waitingForBuffer: boolean;
  player: React.RefObject<SyncPlayerHandle | null>;
}) {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => forceRender((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, []);

  const local = player.current?.getTime() ?? 0;
  const expected = expectedPosition(playback, serverOffset);
  const drift = player.current?.getDrift() ?? 0;
  const buffering = members.filter((m) => m.buffering).map((m) => m.displayName);

  const rows: Array<[string, string]> = [
    ['Connection', connected ? 'connected' : 'DISCONNECTED'],
    ['Clock offset', `${serverOffset >= 0 ? '+' : ''}${Math.round(serverOffset)} ms`],
    ['Room says', `${playback.isPlaying ? 'playing' : 'paused'} @ ${expected.toFixed(2)}s (rate ${playback.rate}x)`],
    ['This player', `${player.current?.isReady() ? 'ready' : 'loading'} @ ${local.toFixed(2)}s`],
    ['Drift', `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s ${Math.abs(drift) > 2 ? '(correcting)' : '(in sync)'}`],
    ['Waiting for buffer', waitingForBuffer ? `yes${buffering.length ? `: ${buffering.join(', ')}` : ''}` : 'no'],
    ['Buffering now', buffering.length ? buffering.join(', ') : 'nobody'],
    ['Source', currentItem ? `${currentItem.source} · ${currentItem.sourceId.slice(0, 40)}` : 'nothing queued'],
    ['Room', `${room.id} · ${room.myRole ?? 'guest'} · control=${room.permissions.canControl}`],
    ['Online', `${members.filter((m) => m.online).length} of ${members.length}`],
    ['State stamp', new Date(playback.stateAt).toISOString().slice(11, 23)],
  ];

  const copy = () => {
    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
    navigator.clipboard?.writeText(`Watch With Friends diagnostics\n${text}`).catch(() => undefined);
  };

  return (
    <div className="debug-panel">
      <div className="row between" style={{ marginBottom: 6 }}>
        <strong className="small">Diagnostics</strong>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn ghost sm" onClick={copy} title="Copy for a bug report">
            Copy
          </button>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close diagnostics">
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
      <table className="debug-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
