import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MediaItem, type PlaylistSummary, type StorageStats } from '../../lib/api';
import { useApp } from '../../state/AppState';
import { EmptyState, Field, Icon, Meter, Modal, Spinner } from '../ui';
import { formatBytes, formatTime, sourceLabel } from '../../lib/format';

type Tab = 'link' | 'search' | 'upload' | 'library';

interface Props {
  roomId: string;
  onClose: () => void;
  onAdd: (items: MediaItem[], atTop?: boolean) => void;
}

export function AddMediaDialog({ roomId, onClose, onAdd }: Props) {
  const { toast } = useApp();
  const [tab, setTab] = useState<Tab>('link');
  const [hasYoutubeApi, setHasYoutubeApi] = useState(false);

  useEffect(() => {
    api
      .get<{ youtubeApi: boolean }>('/media/capabilities')
      .then((c) => setHasYoutubeApi(c.youtubeApi))
      .catch(() => undefined);
  }, []);

  const add = (items: MediaItem[], atTop?: boolean) => {
    onAdd(items, atTop);
    toast(items.length === 1 ? 'Added to the queue' : `Added ${items.length} videos`, 'success');
  };

  return (
    <Modal title="Add something to watch" onClose={onClose} wide>
      <div className="tabs" style={{ borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
        <button className="tab" aria-selected={tab === 'link'} onClick={() => setTab('link')}>
          <Icon name="link" size={14} /> Link
        </button>
        <button className="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>
          <Icon name="search" size={14} /> Search
        </button>
        <button className="tab" aria-selected={tab === 'upload'} onClick={() => setTab('upload')}>
          <Icon name="upload" size={14} /> Upload
        </button>
        <button className="tab" aria-selected={tab === 'library'} onClick={() => setTab('library')}>
          <Icon name="list" size={14} /> Playlists
        </button>
      </div>

      {tab === 'link' && <LinkTab onAdd={add} />}
      {tab === 'search' && <SearchTab enabled={hasYoutubeApi} onAdd={add} />}
      {tab === 'upload' && <UploadTab onAdd={add} />}
      {tab === 'library' && <LibraryTab roomId={roomId} onDone={onClose} />}
    </Modal>
  );
}

/* ---------------------------------------------------------------- */
/* Preview list                                                      */
/* ---------------------------------------------------------------- */

function ItemRow({
  item,
  selected,
  onToggle,
}: {
  item: MediaItem;
  selected?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="result" data-selected={selected} onClick={onToggle} role={onToggle ? 'button' : undefined}>
      <div className="q-thumb" style={{ width: 84 }}>
        {item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" /> : <span>🎞️</span>}
        {item.duration ? <span className="dur">{formatTime(item.duration)}</span> : null}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="clamp2" style={{ fontSize: '0.87rem', fontWeight: 550 }}>{item.title}</div>
        <div className="tiny faint truncate">
          {sourceLabel(item.source)}
          {item.author ? ` · ${item.author}` : ''}
        </div>
      </div>
      {onToggle && (
        <span
          className="center"
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
            background: selected ? 'var(--accent)' : 'transparent',
            color: '#fff',
            flex: 'none',
          }}
        >
          {selected && <Icon name="check" size={12} />}
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Link tab                                                          */
/* ---------------------------------------------------------------- */

function LinkTab({ onAdd }: { onAdd: (items: MediaItem[], atTop?: boolean) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [playlistTitle, setPlaylistTitle] = useState<string | null>(null);
  const [suggestedPlaylist, setSuggestedPlaylist] = useState<string | null>(null);

  const resolve = async (mode: 'auto' | 'playlist' = 'auto') => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    setItems(null);
    setPlaylistTitle(null);
    setSuggestedPlaylist(null);
    try {
      const res = await api.post<{ items: MediaItem[]; playlistTitle?: string; suggestedPlaylistId?: string }>(
        '/media/resolve',
        { url: url.trim(), mode }
      );
      setItems(res.items);
      setPlaylistTitle(res.playlistTitle ?? null);
      setSuggestedPlaylist(res.suggestedPlaylistId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        label="Paste a link"
        hint="YouTube video or playlist · Vimeo · Twitch VOD or channel · direct .mp4/.webm/.m3u8"
      >
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input grow"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && resolve()}
            placeholder="https://www.youtube.com/watch?v=..."
            autoFocus
            spellCheck={false}
          />
          <button className="btn" onClick={() => resolve()} disabled={busy || !url.trim()}>
            {busy ? <span className="spinner" /> : 'Look up'}
          </button>
        </div>
      </Field>

      {error && <div className="form-error">{error}</div>}

      {suggestedPlaylist && (
        <div className="row between card" style={{ padding: '10px 12px', gap: 10 }}>
          <span className="small">That link is part of a playlist.</span>
          <button className="btn sm" onClick={() => resolve('playlist')} disabled={busy}>
            Import the whole playlist
          </button>
        </div>
      )}

      {items && items.length > 0 && (
        <>
          <div className="row between">
            <div className="small muted">
              {playlistTitle ? (
                <>
                  <strong>{playlistTitle}</strong> · {items.length} videos
                </>
              ) : (
                `${items.length} item${items.length === 1 ? '' : 's'} found`
              )}
            </div>
          </div>
          <div className="result-list">
            {items.slice(0, 60).map((item, i) => (
              <ItemRow key={`${item.sourceId}-${i}`} item={item} />
            ))}
            {items.length > 60 && <div className="tiny faint" style={{ padding: 8 }}>+ {items.length - 60} more</div>}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary grow" onClick={() => onAdd(items)}>
              <Icon name="plus" size={15} />{' '}
              {items.length > 1 ? `Add all ${items.length} to queue` : 'Add to queue'}
            </button>
            <button className="btn" onClick={() => onAdd(items, true)} title="Insert before everything else">
              Play next
            </button>
          </div>
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Search tab                                                        */
/* ---------------------------------------------------------------- */

function SearchTab({ enabled, onAdd }: { enabled: boolean; onAdd: (items: MediaItem[]) => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MediaItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.get<{ items: MediaItem[] }>(`/media/search?q=${encodeURIComponent(query.trim())}`);
      setResults(res.items);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) {
    return (
      <EmptyState
        icon="🔑"
        title="YouTube search is not set up"
        hint="An admin can add a YouTube Data API key under Admin → Integrations to enable search and playlist import."
      />
    );
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const chosen = results.filter((r) => selected.has(r.sourceId));

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input grow"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="Search YouTube"
          autoFocus
        />
        <button className="btn" onClick={run} disabled={busy || !query.trim()}>
          {busy ? <span className="spinner" /> : <Icon name="search" size={16} />}
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {busy && results.length === 0 && <Spinner />}

      {results.length > 0 && (
        <>
          <div className="result-list">
            {results.map((item) => (
              <ItemRow
                key={item.sourceId}
                item={item}
                selected={selected.has(item.sourceId)}
                onToggle={() => toggle(item.sourceId)}
              />
            ))}
          </div>
          <button className="btn primary" onClick={() => onAdd(chosen)} disabled={chosen.length === 0}>
            <Icon name="plus" size={15} />{' '}
            {chosen.length > 0 ? `Add ${chosen.length} to queue` : 'Add to queue'}
          </button>
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Upload tab                                                        */
/* ---------------------------------------------------------------- */

function UploadTab({ onAdd }: { onAdd: (items: MediaItem[]) => void }) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [files, setFiles] = useState<Array<{ id: string; name: string; size: number; url: string }>>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .get<{ uploads: Array<{ id: string; name: string; size: number; url: string }>; stats: StorageStats }>('/uploads')
      .then((res) => {
        setFiles(res.uploads);
        setStats(res.stats);
      })
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  const send = async (file: File) => {
    setError(null);
    setProgress(0);
    try {
      const res = await api.upload<{ upload: { id: string; name: string; size: number; url: string }; stats: StorageStats }>(
        '/uploads',
        file,
        setProgress
      );
      setFiles((prev) => [res.upload, ...prev]);
      setStats(res.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setProgress(null);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await api.del<{ stats: StorageStats }>(`/uploads/${id}`);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      setStats(res.stats);
    } catch {
      /* the list refreshes on the next open */
    }
  };

  if (stats && !stats.enabled) {
    return <EmptyState icon="🚫" title="Uploads are disabled" hint="An admin can turn them back on in the admin panel." />;
  }

  const remaining = stats ? Math.max(0, Math.min(stats.globalLimit - stats.globalUsed, stats.userLimit - stats.userUsed)) : 0;

  return (
    <>
      {stats && (
        <div className="card" style={{ padding: 12 }}>
          <div className="row between small" style={{ marginBottom: 6 }}>
            <span className="muted">Your storage</span>
            <span className="faint tiny">
              {formatBytes(stats.userUsed)} of {formatBytes(stats.userLimit)}
            </span>
          </div>
          <Meter used={stats.userUsed} total={stats.userLimit} />
          <div className="tiny faint" style={{ marginTop: 8 }}>
            Server-wide: {formatBytes(stats.globalUsed)} / {formatBytes(stats.globalLimit)} · max{' '}
            {formatBytes(stats.maxFileSize)} per file
          </div>
        </div>
      )}

      <div
        className="drop-zone"
        data-over={dragOver}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void send(file);
        }}
      >
        {progress !== null ? (
          <div className="col" style={{ gap: 8 }}>
            <div className="small">Uploading… {progress}%</div>
            <Meter used={progress} total={100} />
          </div>
        ) : (
          <>
            <Icon name="upload" size={24} />
            <div style={{ marginTop: 6, fontWeight: 600 }}>Drop a video here or click to choose</div>
            <div className="tiny faint">MP4, WebM, MKV, MOV · {formatBytes(remaining)} free</div>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,audio/*,.mkv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
          e.target.value = '';
        }}
      />

      {error && <div className="form-error">{error}</div>}

      {files.length > 0 && (
        <>
          <div className="small muted">Your files</div>
          <div className="result-list">
            {files.map((f) => (
              <div className="result" key={f.id}>
                <div className="q-thumb center" style={{ width: 52 }}>📼</div>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: '0.86rem', fontWeight: 550 }}>{f.name}</div>
                  <div className="tiny faint">{formatBytes(f.size)}</div>
                </div>
                <button
                  className="btn sm"
                  onClick={() =>
                    onAdd([
                      {
                        source: 'upload',
                        sourceId: f.id,
                        url: f.url,
                        title: f.name.replace(/\.[a-z0-9]{2,5}$/i, ''),
                        duration: null,
                        thumbnail: null,
                      },
                    ])
                  }
                >
                  Queue
                </button>
                <button className="btn ghost icon sm danger" onClick={() => remove(f.id)} title="Delete file">
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- */
/* Library tab                                                       */
/* ---------------------------------------------------------------- */

function LibraryTab({ roomId, onDone }: { roomId: string; onDone: () => void }) {
  const { toast } = useApp();
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ playlists: PlaylistSummary[] }>('/playlists')
      .then((res) => setPlaylists(res.playlists))
      .catch(() => setPlaylists([]));
  }, []);

  const load = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api.post<{ added: number }>(`/playlists/${id}/load-into/${roomId}`);
      toast(`Added ${res.added} videos to the queue`, 'success');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load that playlist', 'error');
      setBusyId(null);
    }
  };

  if (!playlists) return <Spinner />;
  if (playlists.length === 0) {
    return (
      <EmptyState
        icon="📚"
        title="No saved playlists yet"
        hint="Save a room queue as a playlist from the queue menu, then load it into any room."
      />
    );
  }

  return (
    <div className="result-list">
      {playlists.map((p) => (
        <div className="result" key={p.id}>
          <div className="q-thumb" style={{ width: 72 }}>
            {p.cover ? <img src={p.cover} alt="" loading="lazy" /> : <span>📁</span>}
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 600, fontSize: '0.88rem' }}>{p.name}</div>
            <div className="tiny faint">
              {p.itemCount} videos{!p.mine && p.ownerName ? ` · from ${p.ownerName}` : ''}
            </div>
          </div>
          <button className="btn sm primary" onClick={() => load(p.id)} disabled={busyId === p.id}>
            {busyId === p.id ? <span className="spinner" /> : 'Load'}
          </button>
        </div>
      ))}
    </div>
  );
}
