import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { db } from '../db';
import { requireAuth } from '../auth';

export const avatarRouter = Router();

const AVATAR_DIR = path.join(config.dataDir, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

/** The browser shrinks pictures to 256px before upload, so this is generous. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * Magic-byte sniffing rather than trusting the declared type: a file that only
 * claims to be an image would otherwise be served straight back to browsers.
 */
function detectImage(buffer: Buffer): { ext: string; mime: string } | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
});

function avatarPathFor(userId: string): { file: string; mime: string } | null {
  for (const [ext, mime] of Object.entries({
    webp: 'image/webp',
    png: 'image/png',
    jpg: 'image/jpeg',
    gif: 'image/gif',
  })) {
    const file = path.join(AVATAR_DIR, `${userId}.${ext}`);
    if (fs.existsSync(file)) return { file, mime };
  }
  return null;
}

function removeExisting(userId: string): void {
  for (const ext of ['webp', 'png', 'jpg', 'gif']) {
    const file = path.join(AVATAR_DIR, `${userId}.${ext}`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

/** Admins may fix somebody else's picture; everyone else only their own. */
function targetUserId(req: Parameters<typeof requireAuth>[0], param?: string): string | null {
  const me = req.user!;
  if (!param || param === 'me' || param === me.id) return me.id;
  if (!me.isAdmin) return null;
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(param);
  return exists ? param : null;
}

avatarRouter.get('/:id/avatar', requireAuth, (req, res) => {
  const found = avatarPathFor(path.basename(req.params.id));
  if (!found) {
    res.status(404).json({ error: 'No picture set' });
    return;
  }
  res.setHeader('Content-Type', found.mime);
  // The URL carries ?v=<updated_at>, so this can be cached hard.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(found.file);
});

avatarRouter.post('/:id/avatar', requireAuth, (req, res) => {
  const userId = targetUserId(req, req.params.id);
  if (!userId) {
    res.status(403).json({ error: 'You can only change your own picture' });
    return;
  }

  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'That picture is larger than 2 MB' : 'Upload failed',
      });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No picture received' });
      return;
    }

    const kind = detectImage(req.file.buffer);
    if (!kind) {
      res.status(400).json({ error: 'That file is not a PNG, JPEG, WebP or GIF image' });
      return;
    }

    removeExisting(userId);
    fs.writeFileSync(path.join(AVATAR_DIR, `${userId}.${kind.ext}`), req.file.buffer);
    const now = Date.now();
    db.prepare('UPDATE users SET avatar_updated_at = ? WHERE id = ?').run(now, userId);

    res.json({ avatarUrl: `/api/users/${userId}/avatar?v=${now}` });
  });
});

avatarRouter.delete('/:id/avatar', requireAuth, (req, res) => {
  const userId = targetUserId(req, req.params.id);
  if (!userId) {
    res.status(403).json({ error: 'You can only change your own picture' });
    return;
  }
  removeExisting(userId);
  db.prepare('UPDATE users SET avatar_updated_at = NULL WHERE id = ?').run(userId);
  res.json({ ok: true });
});

/** Cleans up the file when an account is deleted. */
export function deleteAvatarFiles(userId: string): void {
  try {
    removeExisting(userId);
  } catch {
    /* nothing to do */
  }
}
