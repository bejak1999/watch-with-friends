import { useCallback, useEffect, useState } from 'react';
import { api, type PlaylistSummary, type QueueItem } from '../../lib/api';
import { useApp } from '../../state/AppState';
import { EmptyState, Field, Icon, Modal, Spinner, Toggle } from '../ui';
import { formatTime } from '../../lib/format';

/**
 * Playlists, in the room where they are actually used. The same list lives on
 * the Playlists page, but hunting for it in a dialog while everyone waits is
 * exactly the friction this panel removes.
 */
export function PlaylistsPanel({
  roomId,
  queue,
  canQueue,
  activePlaylistId,
}: {
  roomId: string;
  queue: QueueItem[];
  canQueue: boolean;
  /** The playlist this room's queue came from, if any. */
  activePlaylistId: string | null;
}) {
  const { toast } = useApp();
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  // The bookmark moves while people watch, so refresh it periodically rather
  // than showing a time that quietly goes stale.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  const loadInto = async (id: string, resume: boolean) => {
    setBusyId(id);
    try {
      const res = await api.post<{ added: number; resumed: { title: string; position: number } | null }>(
        `/playlists/${id}/load-into/${roomId}`,
        { resume }
      );
      toast(
        res.resumed
          ? `Picked up at ${formatTime(res.resumed.position)} of "${res.resumed.title}"`
          : `Added ${res.added} videos to the queue`,
        'success'
      );
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load that playlist', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const forget = async (id: string) => {
    try {
      await api.del(`/playlists/${id}/progress`);
      setPlaylists((prev) => prev?.map((p) => (p.id === id ? { ...p, progress: null } : p)) ?? prev);
      toast('Starting from the beginning next time', 'success');
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
        <button
          className="btn ghost icon sm"
          title="Save this queue as a new playlist"
          disabled={queue.length === 0}
          onClick={() => setSaving(true)}
        >
          <Icon name="save" size={15} />
        </button>
      </div>

      <div className="scroll-y" style={{ padding: 6 }}>
        {!playlists ? (
          <Spinner />
        ) : playlists.length === 0 ? (
          <EmptyState
            icon="📚"
            title="No playlists yet"
            hint="Queue some videos, then use the save button above to keep them for next time."
          />
        ) : (
          playlists.map((p) => (
            <div className="pl-row" key={p.id} data-active={p.id === activePlaylistId || undefined}>
              <div className="pl-main">
                <div className="truncate" style={{ fontWeight: 600, fontSize: '0.86rem' }}>
                  {p.name}
                  {p.id === activePlaylistId && <span className="tag" style={{ marginLeft: 6 }}>playing</span>}
                </div>
                <div className="tiny faint">
                  {p.itemCount} videos{!p.mine && p.ownerName ? ` · from ${p.ownerName}` : ''}
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
              {canQueue && (
                <div className="pl-actions">
                  {p.progress ? (
                    <>
                      <button className="btn sm primary" onClick={() => loadInto(p.id, true)} disabled={busyId === p.id}>
                        {busyId === p.id ? <span className="spinner" /> : 'Continue'}
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => loadInto(p.id, false)}
                        disabled={busyId === p.id}
                        title="Load it and start at the first video"
                      >
                        Start over
                      </button>
                      <button
                        className="btn ghost icon sm"
                        onClick={() => forget(p.id)}
                        title="Forget where we got to, without loading it"
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    </>
                  ) : (
                    <button className="btn sm primary" onClick={() => loadInto(p.id, false)} disabled={busyId === p.id}>
                      {busyId === p.id ? <span className="spinner" /> : 'Load'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {saving && (
        <SavePlaylistModal
          roomId={roomId}
          count={queue.length}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function SavePlaylistModal({
  roomId,
  count,
  onClose,
  onSaved,
}: {
  roomId: string;
  count: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post('/playlists', { name: name.trim(), isShared: shared, fromRoomId: roomId });
      toast(`Saved "${name.trim()}"`, 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save it', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Save this queue as a playlist"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>
            {busy ? <span className="spinner" /> : `Save ${count} videos`}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          maxLength={80}
          autoFocus
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
