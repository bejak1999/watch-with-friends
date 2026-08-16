import { useCallback, useEffect, useState } from 'react';
import { api, type MediaItem, type PlaylistProgress, type PlaylistSummary, type RoomSummary } from '../lib/api';
import { useApp } from '../state/AppState';
import { EmptyState, Field, Icon, Modal, Spinner, Toggle } from '../components/ui';
import { formatTime, relativeTime, sourceLabel } from '../lib/format';

interface PlaylistDetail {
  progress: PlaylistProgress | null;
  playlist: {
    id: string;
    name: string;
    description: string | null;
    isShared: boolean;
    ownerId: string | null;
    mine: boolean;
    updatedAt: number;
  };
  items: Array<MediaItem & { id: string }>;
}

export function PlaylistsPage() {
  const { toast } = useApp();
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ playlists: PlaylistSummary[] }>('/playlists');
      setPlaylists(res.playlists);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load playlists', 'error');
      setPlaylists([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const mine = (playlists ?? []).filter((p) => p.mine);
  const shared = (playlists ?? []).filter((p) => !p.mine);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Playlists</h1>
          <div className="sub">Saved queues you can drop into any room.</div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} /> New playlist
        </button>
      </div>

      {playlists === null ? (
        <Spinner />
      ) : playlists.length === 0 ? (
        <EmptyState
          icon="📚"
          title="No playlists yet"
          hint="Import a YouTube playlist here, or save a room queue from the queue panel."
          action={
            <button className="btn primary" onClick={() => setCreating(true)} style={{ marginTop: 8 }}>
              <Icon name="plus" size={16} /> Create one
            </button>
          }
        />
      ) : (
        <>
          {mine.length > 0 && (
            <section className="col">
              <h2>Yours</h2>
              <div className="room-grid">
                {mine.map((p) => (
                  <PlaylistCard key={p.id} playlist={p} onOpen={() => setOpenId(p.id)} />
                ))}
              </div>
            </section>
          )}
          {shared.length > 0 && (
            <section className="col">
              <h2>Shared with everyone</h2>
              <div className="room-grid">
                {shared.map((p) => (
                  <PlaylistCard key={p.id} playlist={p} onOpen={() => setOpenId(p.id)} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {creating && (
        <CreatePlaylistModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void load();
            setOpenId(id);
          }}
        />
      )}
      {openId && (
        <PlaylistDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function PlaylistCard({ playlist, onOpen }: { playlist: PlaylistSummary; onOpen: () => void }) {
  return (
    <button className="room-card" onClick={onOpen} style={{ textAlign: 'left', border: '1px solid var(--border)' }}>
      <div className="room-thumb">
        {playlist.cover ? <img src={playlist.cover} alt="" loading="lazy" /> : <span className="placeholder">📁</span>}
        <div className="overlay">
          <span className="pill">{playlist.itemCount} videos</span>
          {playlist.isShared && <span className="pill">shared</span>}
        </div>
        {/* How far the group got, drawn along the bottom of the cover. */}
        {playlist.progress && playlist.progress.itemCount > 0 && (
          <div className="card-progress">
            <div
              style={{
                width: `${Math.min(100, (playlist.progress.itemIndex / playlist.progress.itemCount) * 100)}%`,
              }}
            />
          </div>
        )}
      </div>
      <div className="room-card-body">
        <div className="truncate" style={{ fontWeight: 650 }}>{playlist.name}</div>
        <div className="tiny faint truncate">
          {playlist.description || (playlist.mine ? 'Your playlist' : `by ${playlist.ownerName ?? 'someone'}`)}
        </div>
        {playlist.progress ? (
          <div className="tiny truncate" style={{ color: 'var(--accent)' }}>
            ▶ {playlist.progress.itemIndex > 0 ? `${playlist.progress.itemIndex}/${playlist.progress.itemCount} · ` : ''}
            {playlist.progress.title} at {formatTime(playlist.progress.position)}
          </div>
        ) : (
          <div className="tiny faint">Updated {relativeTime(playlist.updatedAt)}</div>
        )}
      </div>
    </button>
  );
}

function CreatePlaylistModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [shared, setShared] = useState(true);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);

  const doImport = async () => {
    if (!importUrl.trim()) return;
    setImporting(true);
    try {
      const res = await api.post<{ items: MediaItem[]; playlistTitle?: string }>('/media/resolve', {
        url: importUrl.trim(),
        mode: 'playlist',
      });
      setItems(res.items);
      if (res.playlistTitle && !name) setName(res.playlistTitle);
      toast(`Found ${res.items.length} videos`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<{ id: string }>('/playlists', {
        name: name.trim(),
        description: description.trim() || undefined,
        isShared: shared,
        items,
      });
      onCreated(res.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the playlist', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New playlist"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? <span className="spinner" /> : `Create${items.length ? ` with ${items.length} videos` : ''}`}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
      </Field>
      <Field label="Description" hint="Optional">
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={300}
        />
      </Field>
      <Toggle checked={shared} onChange={setShared} label="Share with everyone" hint="Other users can load it into their rooms." />

      <hr className="divider" />

      <Field label="Import from YouTube" hint="Paste a playlist URL to fill this playlist straight away">
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input grow"
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://www.youtube.com/playlist?list=..."
            spellCheck={false}
          />
          <button className="btn" onClick={doImport} disabled={importing || !importUrl.trim()}>
            {importing ? <span className="spinner" /> : 'Import'}
          </button>
        </div>
      </Field>

      {items.length > 0 && (
        <div className="result-list" style={{ maxHeight: 200 }}>
          {items.slice(0, 40).map((it, i) => (
            <div className="result" key={i}>
              <div className="q-thumb" style={{ width: 64 }}>
                {it.thumbnail ? <img src={it.thumbnail} alt="" loading="lazy" /> : <span>🎞️</span>}
              </div>
              <div className="truncate small grow">{it.title}</div>
            </div>
          ))}
          {items.length > 40 && <div className="tiny faint" style={{ padding: 6 }}>+ {items.length - 40} more</div>}
        </div>
      )}
    </Modal>
  );
}

function PlaylistDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useApp();
  const [data, setData] = useState<PlaylistDetail | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [addUrl, setAddUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<PlaylistDetail>(`/playlists/${id}`)
      .then(setData)
      .catch((err) => {
        toast(err instanceof Error ? err.message : 'Could not open the playlist', 'error');
        onClose();
      });
  }, [id, toast, onClose]);

  useEffect(() => {
    load();
    api.get<{ rooms: RoomSummary[] }>('/rooms').then((r) => setRooms(r.rooms)).catch(() => undefined);
  }, [load]);

  const addItems = async () => {
    if (!addUrl.trim()) return;
    setBusy(true);
    try {
      const res = await api.post<{ items: MediaItem[] }>('/media/resolve', { url: addUrl.trim() });
      await api.post(`/playlists/${id}/items`, { items: res.items });
      setAddUrl('');
      load();
      onChanged();
      toast(`Added ${res.items.length} item${res.items.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add that', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (itemId: string) => {
    await api.del(`/playlists/${id}/items/${itemId}`);
    load();
    onChanged();
  };

  const loadInto = async (roomId: string, resume: boolean) => {
    try {
      const res = await api.post<{ added: number; resumed: { title: string; position: number } | null }>(
        `/playlists/${id}/load-into/${roomId}`,
        { resume }
      );
      toast(
        res.resumed
          ? `Picked up at ${formatTime(res.resumed.position)} of "${res.resumed.title}"`
          : `Queued ${res.added} videos`,
        'success'
      );
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load it', 'error');
    }
  };

  const forgetProgress = async () => {
    try {
      await api.del(`/playlists/${id}/progress`);
      setData((prev) => (prev ? { ...prev, progress: null } : prev));
      toast('Starting from the beginning next time', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not reset it', 'error');
    }
  };

  const destroy = async () => {
    if (!data || !confirm(`Delete the playlist "${data.playlist.name}"?`)) return;
    await api.del(`/playlists/${id}`);
    onChanged();
    onClose();
  };

  if (!data) {
    return (
      <Modal title="Playlist" onClose={onClose}>
        <Spinner />
      </Modal>
    );
  }

  const joinable = rooms.filter((r) => r.myRole || r.isPublic);
  const total = data.items.reduce((sum, i) => sum + (i.duration || 0), 0);

  return (
    <Modal
      title={data.playlist.name}
      onClose={onClose}
      wide
      footer={
        <>
          {data.playlist.mine && (
            <button className="btn danger" onClick={destroy} style={{ marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>Close</button>
        </>
      }
    >
      <div className="row between">
        <div className="small muted">
          {data.items.length} videos{total > 0 ? ` · ${formatTime(total)}` : ''}
        </div>
        {data.playlist.isShared && <span className="tag">shared</span>}
      </div>

      {data.progress && (
        <div className="row between card" style={{ padding: '10px 12px', gap: 10, flexWrap: 'wrap' }}>
          <div className="small" style={{ minWidth: 0 }}>
            <strong>Where you got to:</strong>{' '}
            {data.progress.itemIndex > 0 ? `${data.progress.itemIndex} of ${data.progress.itemCount} · ` : ''}
            <span className="truncate">{data.progress.title}</span> at {formatTime(data.progress.position)}
            <div className="tiny faint">Saved {relativeTime(data.progress.updatedAt)}</div>
          </div>
          <button className="btn sm" onClick={forgetProgress}>
            <Icon name="refresh" size={13} /> Start over next time
          </button>
        </div>
      )}

      {joinable.length > 0 && (
        <Field
          label="Load into a room"
          hint={data.progress ? 'Continue picks up where the group left off.' : undefined}
        >
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {joinable.slice(0, 8).map((r) => (
              <span className="row" key={r.id} style={{ gap: 2 }}>
                <button className="btn sm" onClick={() => loadInto(r.id, Boolean(data.progress))}>
                  <Icon name="play" size={12} /> {r.name}
                  {data.progress ? ' – continue' : ''}
                </button>
                {data.progress && (
                  <button className="btn sm" onClick={() => loadInto(r.id, false)} title={`Load into ${r.name} from the start`}>
                    from the start
                  </button>
                )}
              </span>
            ))}
          </div>
        </Field>
      )}

      {data.playlist.mine && (
        <Field label="Add a video or playlist">
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input grow"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addItems()}
              placeholder="Paste a link"
              spellCheck={false}
            />
            <button className="btn" onClick={addItems} disabled={busy || !addUrl.trim()}>
              {busy ? <span className="spinner" /> : <Icon name="plus" size={16} />}
            </button>
          </div>
        </Field>
      )}

      <div className="result-list" style={{ maxHeight: 380 }}>
        {data.items.map((item) => (
          <div className="result" key={item.id}>
            <div className="q-thumb" style={{ width: 76 }}>
              {item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" /> : <span>🎞️</span>}
              {item.duration ? <span className="dur">{formatTime(item.duration)}</span> : null}
            </div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="clamp2 small" style={{ fontWeight: 550 }}>{item.title}</div>
              <div className="tiny faint">{sourceLabel(item.source)}{item.author ? ` · ${item.author}` : ''}</div>
            </div>
            {data.playlist.mine && (
              <button className="btn ghost icon sm danger" onClick={() => removeItem(item.id)} title="Remove">
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        ))}
        {data.items.length === 0 && <div className="tiny faint" style={{ padding: 12 }}>This playlist is empty.</div>}
      </div>
    </Modal>
  );
}
