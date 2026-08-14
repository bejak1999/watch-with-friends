import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { db, getSettingBool, getSettingNumber } from '../db';
import { newId, requireAuth } from '../auth';

export const uploadsRouter = Router();

const GB = 1024 * 1024 * 1024;

const ALLOWED = new Set([
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'video/x-m4v',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/flac',
  'audio/wav',
  'audio/x-wav',
]);

const EXT_FALLBACK: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

export interface StorageStats {
  globalUsed: number;
  globalLimit: number;
  userUsed: number;
  userLimit: number;
  maxFileSize: number;
  enabled: boolean;
}

export function userQuotaBytes(userId: string): number {
  const row = db.prepare('SELECT upload_quota_bytes FROM users WHERE id = ?').get(userId) as
    | { upload_quota_bytes: number | null }
    | undefined;
  if (row?.upload_quota_bytes != null) return row.upload_quota_bytes;
  return getSettingNumber('upload_default_user_quota_gb') * GB;
}

export function storageStats(userId: string): StorageStats {
  const global = db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS s FROM uploads').get() as { s: number };
  const mine = db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS s FROM uploads WHERE owner_id = ?').get(userId) as {
    s: number;
  };
  return {
    globalUsed: global.s,
    globalLimit: getSettingNumber('upload_global_limit_gb') * GB,
    userUsed: mine.s,
    userLimit: userQuotaBytes(userId),
    maxFileSize: getSettingNumber('max_upload_size_gb') * GB,
    enabled: getSettingBool('upload_enabled'),
  };
}

function remainingBytes(userId: string): number {
  const s = storageStats(userId);
  return Math.max(0, Math.min(s.globalLimit - s.globalUsed, s.userLimit - s.userUsed, s.maxFileSize));
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 64 * GB, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = ALLOWED.has(file.mimetype) ? file.mimetype : EXT_FALLBACK[ext];
    if (!mime) {
      cb(new Error('Only video and audio files can be uploaded'));
      return;
    }
    cb(null, true);
  },
});

uploadsRouter.get('/stats', requireAuth, (req, res) => {
  res.json(storageStats(req.user!.id));
});

uploadsRouter.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM uploads WHERE owner_id = ? ORDER BY created_at DESC')
    .all(req.user!.id) as Array<{
    id: string;
    original_name: string;
    mime: string;
    size_bytes: number;
    created_at: number;
  }>;
  res.json({
    uploads: rows.map((r) => ({
      id: r.id,
      name: r.original_name,
      mime: r.mime,
      size: r.size_bytes,
      createdAt: r.created_at,
      url: `/api/uploads/${r.id}/file`,
    })),
    stats: storageStats(req.user!.id),
  });
});

uploadsRouter.post('/', requireAuth, (req, res) => {
  if (!getSettingBool('upload_enabled')) {
    res.status(403).json({ error: 'Uploads are disabled on this server' });
    return;
  }
  const allowance = remainingBytes(req.user!.id);
  if (allowance <= 0) {
    res.status(413).json({ error: 'No upload space left. Delete something or ask an admin for more quota.' });
    return;
  }

  upload.single('file')(req, res, (err: unknown) => {
    const file = req.file;
    const cleanup = () => {
      if (file?.path) fs.promises.unlink(file.path).catch(() => undefined);
    };

    if (err) {
      cleanup();
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload failed' });
      return;
    }
    if (!file) {
      res.status(400).json({ error: 'No file received' });
      return;
    }
    // Re-check against the live allowance: concurrent uploads could have filled it.
    if (file.size > remainingBytes(req.user!.id)) {
      cleanup();
      res.status(413).json({
        error: `That file is larger than your remaining space (${(allowance / GB).toFixed(2)} GB free)`,
      });
      return;
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const mime = ALLOWED.has(file.mimetype) ? file.mimetype : EXT_FALLBACK[ext] || 'video/mp4';
    const id = newId();
    db.prepare(
      `INSERT INTO uploads (id, owner_id, stored_name, original_name, mime, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.user!.id, file.filename, file.originalname.slice(0, 250), mime, file.size, Date.now());

    res.json({
      upload: {
        id,
        name: file.originalname,
        mime,
        size: file.size,
        url: `/api/uploads/${id}/file`,
      },
      stats: storageStats(req.user!.id),
    });
  });
});

/** Streams the file. express handles Range requests, which video seeking needs. */
uploadsRouter.get('/:id/file', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id) as
    | { stored_name: string; mime: string; original_name: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  const filePath = path.join(config.uploadDir, path.basename(row.stored_name));
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File missing from disk' });
    return;
  }
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

uploadsRouter.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(req.params.id) as
    | { id: string; owner_id: string | null; stored_name: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  if (row.owner_id !== req.user!.id && !req.user!.isAdmin) {
    res.status(403).json({ error: 'That is not your file' });
    return;
  }
  db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
  fs.promises.unlink(path.join(config.uploadDir, path.basename(row.stored_name))).catch(() => undefined);
  res.json({ ok: true, stats: storageStats(req.user!.id) });
});
