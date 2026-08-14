import { useRef, useState } from 'react';
import { api, type User } from '../lib/api';
import { useApp } from '../state/AppState';
import { Avatar, Icon } from './ui';

/** Everything is squared off to this before upload, so files stay tiny. */
const TARGET_PX = 256;

/**
 * Shrinks and centre-crops in the browser. A phone photo is several megabytes
 * and 4000px wide; sending that to the server just to display it at 30px would
 * be silly, and it saves the server needing an image library at all.
 */
async function squareResize(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_PX;
  canvas.height = TARGET_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not process that image');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, TARGET_PX, TARGET_PX);
  bitmap.close?.();

  const blob = await new Promise<Blob | null>((resolve) => {
    // WebP where supported, PNG everywhere else.
    canvas.toBlob((b) => (b ? resolve(b) : canvas.toBlob(resolve, 'image/png')), 'image/webp', 0.9);
  });
  if (!blob) throw new Error('Could not read that image');
  return blob;
}

interface Props {
  user: Pick<User, 'id' | 'displayName' | 'avatarColor' | 'avatarUrl'>;
  /** Admins can edit somebody else; defaults to your own account. */
  targetId?: string;
  onChanged: (avatarUrl: string | null) => void;
}

export function AvatarPicker({ user, targetId, onChanged }: Props) {
  const { toast } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const id = targetId ?? user.id;

  const send = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast('Pick an image file', 'error');
      return;
    }
    setBusy(true);
    try {
      const blob = await squareResize(file);
      const resized = new File([blob], 'avatar.webp', { type: blob.type });
      const res = await api.upload<{ avatarUrl: string }>(`/users/${id}/avatar`, resized);
      onChanged(res.avatarUrl);
      toast('Profile picture updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not upload that picture', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/users/${id}/avatar`);
      onChanged(null);
      toast('Profile picture removed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove it', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ gap: 14, alignItems: 'center' }}>
      <button
        type="button"
        className="avatar-drop"
        data-over={dragOver}
        disabled={busy}
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
        title="Change profile picture"
      >
        <Avatar name={user.displayName} color={user.avatarColor} url={user.avatarUrl} size="lg" />
        <span className="avatar-drop-overlay">
          {busy ? <span className="spinner" /> : <Icon name="upload" size={16} />}
        </span>
      </button>

      <div className="col" style={{ gap: 6 }}>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {user.avatarUrl ? 'Change picture' : 'Upload picture'}
          </button>
          {user.avatarUrl && (
            <button className="btn sm danger" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
        </div>
        <span className="tiny faint">
          Square crop, scaled to {TARGET_PX}×{TARGET_PX} in your browser. PNG, JPEG, WebP or GIF.
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
