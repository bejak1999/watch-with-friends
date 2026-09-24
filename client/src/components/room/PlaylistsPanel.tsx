import { useCallback, useEffect, useState } from 'react';
import { api, type MediaItem, type PlaylistSummary, type QueueItem } from '../../lib/api';
import { useApp } from '../../state/AppState';
import { EmptyState, Field, Icon, Modal, Spinner, Toggle } from '../ui';
import { formatTime, sourceLabel } from '../../lib/format';

type LoadMode = 'play' | 'queue';

interface LoadResult {
  added: number;
  started: boolean;
  resumed: { title: string; position: number } | null;
}

/**
 * Playlists, in the room where they are used.
 *
 * Two jobs, kept apart on purpose. Building and editing a playlist - creating
 * one, pasting links into it, removing videos - never touches the queue. The
 * queue only changes when somebody presses Play or Queue, and those two say
 * plainly whether the video on screen gets interrupted.
 */
export function PlaylistsPanel({
  roomId,
  queue,
  canQueue,
  activePlaylistId,
  roomBusy,
  onStarting,
}: {
  roomId: string;
  queue: QueueItem[];
  canQueue: boolean;
  /** The playlist the video on screen came from, if any. */
  activePlaylistId: string | null;
  /** Something is playing right now, so "play" would interrupt it. */
  roomBusy: boolean;
  /** Called on a press that may start playback, so this browser joins in with sound. */
  onStarting: () => void;
}) {
  const { user, toast } = useApp();
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

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
  }, [load]);

  // The bookmark moves while people watch, so keep it from quietly going stale.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  const loadInto = async (p: PlaylistSummary, mode: LoadMode, resume: boolean) => {
    setBusyId(p.id);
    onStarting();
    try {
      const res = await api.post<LoadResult>(`/playlists/${p.id}/load-into/${roomId}`, { mode, resume });
      toast(
        res.started && res.resumed
          ? `Continuing at ${formatTime(res.resumed.position)} of "${res.resumed.title}"`
          : res.started
            ? `Playing "${p.name}"`
            : `Queued ${res.added} video${res.added === 1 ? '' : 's'} from "${p.name}"`,
        'success'
      );
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load that playlist', 'error');
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
        <button className="btn sm" onClick={() => setCreating(true)} title="Build a playlist - the queue stays as it is">
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
          playlists.map((p) => (
            <PlaylistRow
              key={p.id}
              p={p}
              active={p.id === activePlaylistId}
              open={openId === p.id}
              onToggle={() => setOpenId((cur) => (cur === p.id ? null : p.id))}
              canQueue={canQueue}
              editable={p.mine || Boolean(user?.isAdmin)}
              roomBusy={roomBusy}
              busy={busyId === p.id}
              onPlay={() => loadInto(p, 'play', Boolean(p.progress))}
              onStartOver={() => loadInto(p, 'play', false)}
              onQueue={() => loadInto(p, 'queue', Boolean(p.progress))}
              onForget={() => forget(p)}
              onChanged={load}
              onDeleted={() => {
                setOpenId(null);
                void load();
              }}
            />
          ))
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
  open,
  onToggle,
  canQueue,
  editable,
  roomBusy,
  busy,
  onPlay,
  onStartOver,
  onQueue,
  onForget,
  onChanged,
  onDeleted,
}: {
  p: PlaylistSummary;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  canQueue: boolean;
  editable: boolean;
  roomBusy: boolean;
  busy: boolean;
  onPlay: () => void;
  onStartOver: () => void;
  onQueue: () => void;
  onForget: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const bookmarked = Boolean(p.progress);
  const playLabel = bookmarked ? 'Continue' : roomBusy ? 'Play now' : 'Play';
  const playHint = roomBusy
    ? 'Starts right away, after the video that is on now. Nothing is taken out of the queue.'
    : 'Starts right away.';
  const queueHint = roomBusy
    ? `Adds ${bookmarked ? 'the rest of it' : 'it'} to the end of the queue - nothing gets interrupted.`
    : 'Nothing is playing, so this starts it straight away.';

  return (
    <div className="pl-row" data-active={active || undefined} data-open={open || undefined}>
      <button className="pl-head" onClick={onToggle} aria-expanded={open} title={open ? 'Hide the videos' : 'Show the videos'}>
        <div className="pl-main">
          <div className="pl-name clamp2">
            {p.name}
            {active && <span className="tag" style={{ marginLeft: 6 }}>playing</span>}
          </div>
          <div className="tiny faint">
            {p.itemCount} video{p.itemCount === 1 ? '' : 's'}
            {!p.mine && p.ownerName ? ` · from ${p.ownerName}` : ''}
          </div>
          {p.progress ? (
            <div className="tiny truncate" style={{ color: 'var(--accent)' }}>
              ▶ {p.progress.itemIndex > 0 ? `${p.progress.itemIndex}/${p.progress.itemCount} · ` : ''}
              {p.progress.title} at {formatTime(p.progress.position)}
            </div>
          ) : (
            <div className="tiny faint">Not started</div>
          )}
        </div>
        <span className="pl-chevron" data-open={open || undefined}>
          <Icon name="chevron-down" size={15} />
        </span>
      </button>

      {canQueue ? (
        <div className="pl-actions">
          <button className="btn sm primary" onClick={onPlay} disabled={busy} title={playHint}>
            {busy ? <span className="spinner" /> : <Icon name="play" size={13} />} {playLabel}
          </button>
          <button className="btn sm" onClick={onQueue} disabled={busy} title={queueHint}>
            <Icon name="plus" size={13} /> Queue
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
      ) : (
        <div className="tiny faint">Only hosts can start playlists in this room.</div>
      )}

      {open && <PlaylistVideos id={p.id} editable={editable} onChanged={onChanged} onDeleted={onDeleted} />}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Its videos - edited here without touching the queue               */
/* ---------------------------------------------------------------- */

interface PlaylistVideo extends MediaItem {
  id: string;
}

function PlaylistVideos({
  id,
  editable,
  onChanged,
  onDeleted,
}: {
  id: string;
  editable: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useApp();
  const [items, setItems] = useState<PlaylistVideo[] | null>(null);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [adding, setAdding] = useState(false);
  const [offerWhole, setOfferWhole] = useState(false);

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
  }, [load]);

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
    if (!confirm(`Delete the playlist "${name}"? The queue is not affected.`)) return;
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
          </div>
          <ol className="pl-video-list">
            {items.map((it, i) => (
              <li key={it.id} className="pl-video">
                <span className="pl-video-n">{i + 1}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="pl-video-title clamp3">{it.title}</div>
                  <div className="tiny faint">
                    {sourceLabel(it.source)}
                    {it.duration ? ` · ${formatTime(it.duration)}` : ''}
                  </div>
                </div>
                {editable && (
                  <button className="btn ghost icon sm" onClick={() => remove(it)} title="Remove from this playlist">
                    <Icon name="close" size={12} />
                  </button>
                )}
              </li>
            ))}
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
            <button className="btn sm" onClick={() => add('auto')} disabled={adding || !link.trim()} title="Adds to this playlist - the queue stays as it is">
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
