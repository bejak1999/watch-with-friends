import { useState } from 'react';
import type { QueueItem } from '../../lib/api';
import { api } from '../../lib/api';
import { useApp } from '../../state/AppState';
import { EmptyState, Field, Icon, Modal } from '../ui';
import { formatTime, sourceIcon, sourceLabel } from '../../lib/format';
import type { RoomActions } from '../../hooks/useRoom';

interface Props {
  roomId: string;
  queue: QueueItem[];
  currentItemId: string | null;
  canQueue: boolean;
  canControl: boolean;
  repeatMode: 'off' | 'one' | 'all';
  actions: RoomActions;
  onAddClick: () => void;
}

export function QueuePanel({
  roomId,
  queue,
  currentItemId,
  canQueue,
  canControl,
  repeatMode,
  actions,
  onAddClick,
}: Props) {
  const { toast } = useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const totalDuration = queue.reduce((sum, q) => sum + (q.duration || 0), 0);
  const currentIndex = queue.findIndex((q) => q.id === currentItemId);
  const remaining = queue.slice(currentIndex + 1).reduce((sum, q) => sum + (q.duration || 0), 0);

  const onDrop = (index: number) => {
    if (dragId) actions.moveInQueue(dragId, index);
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <div className="side-body">
      <div className="row between" style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
        <div className="tiny faint">
          {queue.length} item{queue.length === 1 ? '' : 's'}
          {totalDuration > 0 && ` · ${formatTime(totalDuration)}`}
          {remaining > 0 && currentIndex >= 0 && ` · ${formatTime(remaining)} left`}
        </div>
        <div className="row" style={{ gap: 2 }}>
          <button
            className="btn ghost icon sm"
            title={`Repeat: ${repeatMode}`}
            disabled={!canControl}
            onClick={() => actions.setRepeat(repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off')}
            style={{ color: repeatMode !== 'off' ? 'var(--accent)' : undefined }}
          >
            <Icon name={repeatMode === 'one' ? 'repeat-one' : 'repeat'} size={15} />
          </button>
          <button
            className="btn ghost icon sm"
            title="Shuffle the queue"
            disabled={!canQueue || queue.length < 3}
            onClick={() => actions.shuffleQueue()}
          >
            <Icon name="shuffle" size={15} />
          </button>
          <button
            className="btn ghost icon sm"
            title="Save queue as a playlist"
            disabled={queue.length === 0}
            onClick={() => setSaving(true)}
          >
            <Icon name="save" size={15} />
          </button>
          <button
            className="btn ghost icon sm danger"
            title="Clear the queue"
            disabled={!canQueue || queue.length === 0}
            onClick={() => {
              if (confirm('Remove everything except what is playing?')) actions.clearQueue(true);
            }}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>

      <div className="scroll-y" style={{ padding: 6 }} onDragOver={(e) => e.preventDefault()}>
        {queue.length === 0 ? (
          <EmptyState
            icon="📼"
            title="The queue is empty"
            hint={canQueue ? 'Add a YouTube link, search, or upload a file.' : 'Wait for a host to add something.'}
            action={
              canQueue ? (
                <button className="btn primary sm" onClick={onAddClick} style={{ marginTop: 6 }}>
                  <Icon name="plus" size={14} /> Add media
                </button>
              ) : undefined
            }
          />
        ) : (
          queue.map((item, index) => (
            <div
              key={item.id}
              className={[
                'queue-item',
                item.id === currentItemId ? 'current' : '',
                dragId === item.id ? 'dragging' : '',
                dropIndex === index ? 'drop-before' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              draggable={canQueue}
              onDragStart={() => setDragId(item.id)}
              onDragEnd={() => {
                setDragId(null);
                setDropIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragId && dragId !== item.id) setDropIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(index);
              }}
              onDoubleClick={() => canControl && actions.select(item.id)}
            >
              <div className="q-thumb">
                {item.thumbnail ? (
                  <img src={item.thumbnail} alt="" loading="lazy" />
                ) : (
                  <span>{sourceIcon(item.source)}</span>
                )}
                {item.duration ? <span className="dur">{formatTime(item.duration)}</span> : null}
                {item.id === currentItemId && (
                  <span
                    className="center"
                    style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', color: '#fff' }}
                  >
                    <Icon name="play" size={16} />
                  </span>
                )}
              </div>

              <div className="grow" style={{ minWidth: 0 }}>
                <div className="q-title clamp2">{item.title}</div>
                <div className="q-meta truncate">
                  {sourceLabel(item.source)}
                  {item.addedByName ? ` · ${item.addedByName}` : ''}
                </div>
              </div>

              <div className="q-actions">
                {canControl && item.id !== currentItemId && (
                  <button
                    className="btn ghost icon sm"
                    title="Play this now"
                    onClick={() => actions.select(item.id)}
                  >
                    <Icon name="play" size={13} />
                  </button>
                )}
                {canQueue && (
                  <button
                    className="btn ghost icon sm"
                    title="Remove"
                    onClick={() => actions.removeFromQueue(item.id)}
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {canQueue && (
        <div className="side-foot">
          <button className="btn primary block" onClick={onAddClick}>
            <Icon name="plus" size={16} /> Add media
          </button>
        </div>
      )}

      {saving && (
        <SavePlaylistModal
          roomId={roomId}
          count={queue.length}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            toast('Playlist saved', 'success');
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
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Save queue as playlist"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim()}>
            {busy ? <span className="spinner" /> : 'Save playlist'}
          </button>
        </>
      }
    >
      <Field label="Playlist name" hint={`${count} item${count === 1 ? '' : 's'} will be saved`}>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="Horror night part 2"
          maxLength={80}
          autoFocus
        />
      </Field>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        <span className="small">Share with everyone on this server</span>
      </label>
    </Modal>
  );
}
