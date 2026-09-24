import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type MediaItem, type PlaylistSummary, type QueueItem } from '../../lib/api';
import { useApp } from '../../state/AppState';
import { EmptyState, Field, Icon, Modal, Spinner, Toggle } from '../ui';
import { formatTime, sourceLabel } from '../../lib/format';

interface PlayResult {
  itemId: string;
  resumed: { title: string; position: number } | null;
}

/**
 * Saved playlists, in the room where they are watched.
 *
 * They play on their own - nothing is copied into the queue. The queue is for
 * one-off videos; a playlist runs from episode to episode until its end and
 * then stops. Building and editing one never touches what is playing either.
 */
export function PlaylistsPanel({
  roomId,
  queue,
  canControl,
  activePlaylistId,
  currentItemId,
  isPlaying,
  version,
  onStarting,
}: {
  roomId: string;
  queue: QueueItem[];
  canControl: boolean;
  /** The playlist the room is playing from right now, if any. */
  activePlaylistId: string | null;
  currentItemId: string | null;
  isPlaying: boolean;
  /** Changes whenever somebody edits a playlist, so the lists refetch. */
  version: number;
  /** Called on a press that may start playback, so this browser joins in with sound. */
  onStarting: () => void;
}) {
  const { user, toast } = useApp();
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The playlist on screen starts unfolded, so its episodes are one glance away.
  const [openId, setOpenId] = useState<string | null>(activePlaylistId);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ playlists: PlaylistSummary[] }>('/playlists');
      setPlaylists(res.playlists);
    } catch {
      setPlaylists([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, version]);

  // The bookmark moves while people watch, so keep it from quietly going stale.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (activePlaylistId) setOpenId(activePlaylistId);
  }, [activePlaylistId]);

  const play = async (p: PlaylistSummary, body: { itemId?: string; resume?: boolean }) => {
    setBusyId(p.id);
    onStarting();
    try {
      const res = await api.post<PlayResult>(`/playlists/${p.id}/play/${roomId}`, body);
      if (res.resumed) toast(`Continuing at ${formatTime(res.resumed.position)} of "${res.resumed.title}"`, 'success');
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not play that', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const forget = async (p: PlaylistSummary) => {
    try {
      await api.del(`/playlists/${p.id}/progress`);
      setPlaylists((prev) => prev?.map((x) => (x.id === p.id ? { ...x, progress: null } : x)) ?? prev);
      toast(`"${p.name}" will start from the beginning`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not reset it', 'error');
    }
  };

  return (
    <div className="side-body">
      <div
        className="row between"
        style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)', flex: 'none' }}
      >
        <div className="tiny faint">
          {playlists ? `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}` : 'Loading…'}
        </div>
        <button className="btn sm" onClick={() => setCreating(true)} title="Build a playlist - nothing starts playing">
          <Icon name="plus" size={14} /> New playlist
        </button>
      </div>

      <div className="scroll-y" style={{ padding: 6 }}>
        {!playlists ? (
          <Spinner />
        ) : playlists.length === 0 ? (
          <EmptyState
            icon="📚"
            title="No playlists yet"
            hint="Create one from a YouTube playlist link, or from what is in the queue right now."
            action={
              <button className="btn primary sm" onClick={() => setCreating(true)} style={{ marginTop: 8 }}>
                <Icon name="plus" size={14} /> New playlist
              </button>
            }
          />
        ) : (
          playlists.map((p) => {
            const active = p.id === activePlaylistId;
            return (
              <PlaylistRow
                key={p.id}
                p={p}
                active={active}
                playing={active && isPlaying}
                open={openId === p.id}
                onToggle={() => setOpenId((cur) => (cur === p.id ? null : p.id))}
                canControl={canControl}
                editable={p.mine || Boolean(user?.isAdmin)}
                busy={busyId === p.id}
                onPlay={() => play(p, { resume: Boolean(p.progress) })}
                onStartOver={() => play(p, {})}
                onForget={() => forget(p)}
                videos={
                  openId === p.id ? (
                    <PlaylistVideos
                      id={p.id}
                      version={version}
                      editable={p.mine || Boolean(user?.isAdmin)}
                      canControl={canControl}
                      currentItemId={active ? currentItemId : null}
                      bookmark={p.progress}
                      onPlayItem={(itemId) => play(p, { itemId })}
                      onChanged={load}
                      onDeleted={() => {
                        setOpenId(null);
                        void load();
                      }}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </div>

      {creating && (
        <NewPlaylistModal
          roomId={roomId}
          queueLength={queue.length}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* One playlist                                                      */
/* ---------------------------------------------------------------- */

function PlaylistRow({
  p,
  active,
  playing,
  open,
  onToggle,
  canControl,
  busy,
  onPlay,
  onStartOver,
  onForget,
  videos,
}: {
  p: PlaylistSummary;
  active: boolean;
  playing: boolean;
  open: boolean;
  onToggle: () => void;
  canControl: boolean;
  editable: boolean;
  busy: boolean;
  onPlay: () => void;
  onStartOver: () => void;
  onForget: () => void;
  videos: ReactNode;
}) {
  const bookmarked = Boolean(p.progress);

  return (
    <div className="pl-row" data-active={active || undefined} data-open={open || undefined}>
      <button className="pl-head" onClick={onToggle} aria-expanded={open} title={open ? 'Hide the videos' : 'Show the videos'}>
        <div className="q-thumb pl-cover">
          {p.cover ? <img src={p.cover} alt="" loading="lazy" /> : <span>📁</span>}
          <span className="dur">{p.itemCount}</span>
        </div>
        <div className="pl-main">
          <div className="pl-name clamp2">{p.name}</div>
          <div className="tiny faint">
            {active ? (
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{playing ? 'Playing now' : 'On screen, paused'}</span>
            ) : (
              <>
                {p.itemCount} video{p.itemCount === 1 ? '' : 's'}
                {!p.mine && p.ownerName ? ` · from ${p.ownerName}` : ''}
              </>
            )}
          </div>
          {p.progress ? (
            <div className="tiny truncate" style={{ color: 'var(--accent)' }}>
              ▶ {p.progress.itemIndex > 0 ? `${p.progress.itemIndex}/${p.progress.itemCount} · ` : ''}
              {p.progress.title} at {formatTime(p.progress.position)}
            </div>
          ) : (
            !active && <div className="tiny faint">Not started</div>
          )}
        </div>
        <span className="pl-chevron" data-open={open || undefined}>
          <Icon name="chevron-down" size={15} />
        </span>
      </button>

      {canControl ? (
        !active && (
          <div className="pl-actions">
            <button
              className="btn sm primary"
              onClick={onPlay}
              disabled={busy || p.itemCount === 0}
              title={bookmarked ? 'Pick up where the group left off' : 'Play it from the first video'}
            >
              {busy ? <span className="spinner" /> : <Icon name="play" size={13} />} {bookmarked ? 'Continue' : 'Play'}
            </button>
            {bookmarked && (
              <>
                <button className="btn ghost icon sm" onClick={onStartOver} disabled={busy} title="Play it from the first video">
                  <Icon name="prev" size={13} />
                </button>
                <button
                  className="btn ghost icon sm"
                  onClick={onForget}
                  disabled={busy}
                  title="Forget where we got to, without playing anything"
                >
                  <Icon name="refresh" size={13} />
                </button>
              </>
            )}
          </div>
        )
      ) : (
        <div className="tiny faint">Only hosts can start playlists in this room.</div>
      )}

      {videos}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Its videos - click one to play it                                 */
/* ---------------------------------------------------------------- */

interface PlaylistVideo extends MediaItem {
  id: string;
}

function PlaylistVideos({
  id,
  version,
  editable,
  canControl,
  currentItemId,
  bookmark,
  onPlayItem,
  onChanged,
  onDeleted,
}: {
  id: string;
  version: number;
  editable: boolean;
  canControl: boolean;
  /** The episode on screen, when the room plays this playlist. */
  currentItemId: string | null;
  bookmark: PlaylistSummary['progress'];
  onPlayItem: (itemId: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useApp();
  const [items, setItems] = useState<PlaylistVideo[] | null>(null);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [adding, setAdding] = useState(false);
  const [offerWhole, setOfferWhole] = useState(false);
  const currentRef = useRef<HTMLLIElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ playlist: { name: string }; items: PlaylistVideo[] }>(`/playlists/${id}`);
      setItems(res.items);
      setName(res.playlist.name);
    } catch {
      setItems([]);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // Keep the episode on screen in view as the playlist moves on.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [currentItemId, items]);

  const add = async (mode: 'auto' | 'playlist') => {
    if (!link.trim()) return;
    setAdding(true);
    setOfferWhole(false);
    try {
      const found = await api.post<{ items: MediaItem[]; suggestedPlaylistId?: string }>('/media/resolve', {
        url: link.trim(),
        mode,
      });
      if (found.items.length === 0) {
        toast('Nothing playable found at that link', 'error');
        return;
      }
      await api.post(`/playlists/${id}/items`, { items: found.items });
      toast(`Added ${found.items.length} video${found.items.length === 1 ? '' : 's'} to "${name}"`, 'success');
      // A video from inside a YouTube playlist: offer the rest of it too.
      if (mode === 'auto' && found.suggestedPlaylistId) setOfferWhole(true);
      else setLink('');
      void load();
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add that', 'error');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (item: PlaylistVideo) => {
    try {
      await api.del(`/playlists/${id}/items/${item.id}`);
      setItems((prev) => prev?.filter((x) => x.id !== item.id) ?? prev);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove it', 'error');
    }
  };

  const destroy = async () => {
    if (!confirm(`Delete the playlist "${name}"?`)) return;
    try {
      await api.del(`/playlists/${id}`);
      toast(`Deleted "${name}"`, 'success');
      onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete it', 'error');
    }
  };

  if (!items) return <Spinner />;
  const total = items.reduce((sum, i) => sum + (i.duration || 0), 0);
  // With nothing on screen from this playlist, mark where the group left off.
  const bookmarkIndex =
    !currentItemId && bookmark
      ? items.findIndex((it) => it.source === bookmark.source && it.sourceId === bookmark.sourceId)
      : -1;

  return (
    <div className="pl-videos">
      {items.length === 0 ? (
        <div className="tiny faint" style={{ padding: '4px 2px' }}>
          Empty so far.{editable ? ' Paste a link below to fill it.' : ''}
        </div>
      ) : (
        <>
          <div className="tiny faint">
            {items.length} video{items.length === 1 ? '' : 's'}
            {total > 0 ? ` · ${formatTime(total)}` : ''}
            {canControl ? ' · click one to play it' : ''}
          </div>
          <ol className="pl-video-list">
            {items.map((it, i) => {
              const current = it.id === currentItemId;
              const marked = i === bookmarkIndex;
              return (
                <li
                  key={it.id}
                  ref={current ? currentRef : undefined}
                  className={['pl-video', current ? 'current' : '', canControl ? 'playable' : ''].join(' ')}
                  onClick={() => canControl && !current && onPlayItem(it.id)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && canControl && !current) {
                      e.preventDefault();
                      onPlayItem(it.id);
                    }
                  }}
                  tabIndex={canControl ? 0 : undefined}
                  title={canControl && !current ? 'Play this one' : undefined}
                >
                  <span className="pl-video-n">{i + 1}</span>
                  <div className="q-thumb pl-video-thumb">
                    {it.thumbnail ? <img src={it.thumbnail} alt="" loading="lazy" /> : <span>🎞️</span>}
                    {it.duration ? <span className="dur">{formatTime(it.duration)}</span> : null}
                    {(current || (canControl && !current)) && (
                      <span className="pl-video-play" data-current={current || undefined}>
                        <Icon name="play" size={14} />
                      </span>
                    )}
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="pl-video-title clamp3">{it.title}</div>
                    <div className="tiny faint">
                      {current ? (
                        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>Now playing</span>
                      ) : marked ? (
                        <span style={{ color: 'var(--accent)' }}>Left off at {formatTime(bookmark!.position)}</span>
                      ) : (
                        sourceLabel(it.source)
                      )}
                    </div>
                  </div>
                  {editable && (
                    <button
                      className="btn ghost icon sm pl-video-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(it);
                      }}
                      title="Remove from this playlist"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}

      {editable && (
        <>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="input"
              style={{ height: 32, fontSize: '0.82rem' }}
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setOfferWhole(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && add('auto')}
              placeholder="Paste a link to add it here"
              spellCheck={false}
            />
            <button className="btn sm" onClick={() => add('auto')} disabled={adding || !link.trim()} title="Adds it to the end of this playlist">
              {adding ? <span className="spinner" /> : <Icon name="plus" size={13} />}
            </button>
          </div>
          {offerWhole && (
            <div className="row between" style={{ gap: 6 }}>
              <span className="tiny faint">That video is part of a YouTube playlist.</span>
              <button className="btn sm" onClick={() => add('playlist')} disabled={adding}>
                Add the whole playlist
              </button>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost sm danger" onClick={destroy}>
              <Icon name="trash" size={12} /> Delete playlist
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* New playlist                                                      */
/* ---------------------------------------------------------------- */

function NewPlaylistModal({
  roomId,
  queueLength,
  onClose,
  onCreated,
}: {
  roomId: string;
  queueLength: number;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(true);
  const [source, setSource] = useState<'link' | 'queue' | 'empty'>('link');
  const [link, setLink] = useState('');
  const [found, setFound] = useState<MediaItem[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);

  const lookUp = async () => {
    if (!link.trim()) return;
    setLooking(true);
    setFound(null);
    try {
      // A link to a whole YouTube playlist, or a video that sits inside one, is
      // imported as the whole list - that is what starting a playlist from a
      // link almost always means.
      const wantsList = /[?&]list=/.test(link);
      const res = await api.post<{ items: MediaItem[]; playlistTitle?: string }>('/media/resolve', {
        url: link.trim(),
        mode: wantsList ? 'playlist' : 'auto',
      });
      setFound(res.items);
      if (!name.trim() && res.playlistTitle) setName(res.playlistTitle);
      else if (!name.trim() && res.items.length === 1) setName(res.items[0].title.slice(0, 80));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not read that link', 'error');
    } finally {
      setLooking(false);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), isShared: shared };
      if (source === 'queue') body.fromRoomId = roomId;
      if (source === 'link' && found) body.items = found;
      const res = await api.post<{ id: string }>('/playlists', body);
      toast(`Created "${name.trim()}"`, 'success');
      onCreated(res.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create it', 'error');
      setBusy(false);
    }
  };

  const count = source === 'queue' ? queueLength : source === 'link' ? found?.length ?? 0 : 0;

  return (
    <Modal
      title="New playlist"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={create}
            disabled={busy || !name.trim() || (source === 'link' && link.trim() !== '' && !found)}
          >
            {busy ? <span className="spinner" /> : count > 0 ? `Create with ${count} video${count === 1 ? '' : 's'}` : 'Create'}
          </button>
        </>
      }
    >
      <div className="sub small">A playlist is kept on its own - creating one does not change the queue.</div>

      <div className="tabs" style={{ borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
        <button className="tab" aria-selected={source === 'link'} onClick={() => setSource('link')}>
          <Icon name="link" size={13} /> From a link
        </button>
        <button
          className="tab"
          aria-selected={source === 'queue'}
          onClick={() => setSource('queue')}
          disabled={queueLength === 0}
          title={queueLength === 0 ? 'The queue is empty' : undefined}
        >
          <Icon name="list" size={13} /> From the queue
        </button>
        <button className="tab" aria-selected={source === 'empty'} onClick={() => setSource('empty')}>
          <Icon name="plus" size={13} /> Empty
        </button>
      </div>

      {source === 'link' && (
        <Field label="Link" hint="A YouTube playlist, a single video, or anything else you can add to a room.">
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input grow"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setFound(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && lookUp()}
              placeholder="https://www.youtube.com/playlist?list=…"
              spellCheck={false}
              autoFocus
            />
            <button className="btn" onClick={lookUp} disabled={looking || !link.trim()}>
              {looking ? <span className="spinner" /> : 'Look up'}
            </button>
          </div>
          {found && (
            <div className="tiny" style={{ color: 'var(--success)', marginTop: 4 }}>
              ✓ Found {found.length} video{found.length === 1 ? '' : 's'}
            </div>
          )}
        </Field>
      )}

      {source === 'queue' && (
        <div className="small muted">Copies the {queueLength} video{queueLength === 1 ? '' : 's'} in the queue into a new playlist. The queue itself stays as it is.</div>
      )}

      {source === 'empty' && (
        <div className="small muted">Starts empty - open it afterwards and paste links in.</div>
      )}

      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          maxLength={80}
          placeholder="Season 2, Movie night, …"
        />
      </Field>

      <Toggle
        checked={shared}
        onChange={setShared}
        label="Share with everyone"
        hint="Shared playlists show up for all your friends, and everyone continues from the same place."
      />
    </Modal>
  );
}
