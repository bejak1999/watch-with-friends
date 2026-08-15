import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { config } from '../config';
import { allSettings, db, setSetting } from '../db';
import { hashPassword, requireAdmin, revokeSessions } from '../auth';
import { storageStats } from './uploads';
import { activeLockouts, clearLockout } from '../services/rateLimit';
import { forgetRoom, kickUser } from '../realtime';
import { deleteAvatarFiles } from './avatars';
import { globalStats } from '../services/stats';
import multer from 'multer';
import {
  BackupError,
  cancelRestore,
  createBackup,
  pendingRestore,
  stageRestore,
} from '../services/backup';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const GB = 1024 * 1024 * 1024;
/** No I/O/0/1 - these get misread when codes are typed off a screen. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i % 4 === 3 && i !== 11) out += '-';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Invite codes                                                        */
/* ------------------------------------------------------------------ */

adminRouter.get('/codes', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, u.display_name AS creator,
              (SELECT GROUP_CONCAT(u2.username, ', ')
                 FROM invite_redemptions r JOIN users u2 ON u2.id = r.user_id
                WHERE r.code = c.code) AS redeemed_by
       FROM invite_codes c LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.created_at DESC`
    )
    .all() as Array<Record<string, unknown>>;
  res.json({
    codes: rows.map((r) => ({
      code: r.code,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxUses: r.max_uses,
      uses: r.uses,
      note: r.note,
      revoked: r.revoked === 1,
      grantsAdmin: r.grants_admin === 1,
      creator: r.creator,
      redeemedBy: r.redeemed_by,
    })),
  });
});

const codeSchema = z.object({
  count: z.number().int().min(1).max(50).optional(),
  maxUses: z.number().int().min(0).max(1000).optional(),
  expiresInDays: z.number().int().min(0).max(3650).optional(),
  note: z.string().trim().max(120).optional(),
  grantsAdmin: z.boolean().optional(),
});

adminRouter.post('/codes', (req, res) => {
  const parsed = codeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid code options' });
    return;
  }
  const { count = 1, maxUses = 1, expiresInDays = 0, note, grantsAdmin } = parsed.data;
  const now = Date.now();
  const expiresAt = expiresInDays > 0 ? now + expiresInDays * 86400000 : null;
  const created: string[] = [];

  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const code = generateCode();
      db.prepare(
        `INSERT INTO invite_codes (code, created_by, created_at, expires_at, max_uses, uses, note, grants_admin)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(code.replace(/-/g, ''), req.user!.id, now, expiresAt, maxUses, note || null, grantsAdmin ? 1 : 0);
      created.push(code);
    }
  });
  tx();

  res.json({ codes: created });
});

adminRouter.post('/codes/:code/revoke', (req, res) => {
  const code = req.params.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  db.prepare('UPDATE invite_codes SET revoked = 1 WHERE code = ?').run(code);
  res.json({ ok: true });
});

adminRouter.delete('/codes/:code', (req, res) => {
  const code = req.params.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

adminRouter.get('/users', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.*,
              (SELECT COALESCE(SUM(size_bytes),0) FROM uploads up WHERE up.owner_id = u.id) AS storage_used,
              (SELECT COUNT(*) FROM rooms r WHERE r.owner_id = u.id) AS rooms_owned
       FROM users u ORDER BY u.created_at ASC`
    )
    .all() as Array<Record<string, any>>;
  res.json({
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      isAdmin: r.is_admin === 1,
      isDisabled: r.is_disabled === 1,
      avatarColor: r.avatar_color,
      avatarUrl: r.avatar_updated_at ? `/api/users/${r.id}/avatar?v=${r.avatar_updated_at}` : null,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      storageUsed: r.storage_used,
      quotaBytes: r.upload_quota_bytes,
      roomsOwned: r.rooms_owned,
    })),
  });
});

const userPatchSchema = z.object({
  isAdmin: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
  /** null resets to the server default. */
  quotaGb: z.number().min(0).max(10000).nullable().optional(),
  newPassword: z.string().min(8).max(200).optional(),
  displayName: z.string().trim().min(1).max(32).optional(),
});

adminRouter.patch('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const parsed = userPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid change' });
    return;
  }
  const d = parsed.data;

  // Never let the last admin lock everyone out.
  if ((d.isAdmin === false || d.isDisabled === true) && target.is_admin === 1) {
    const admins = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND is_disabled = 0').get() as {
      c: number;
    };
    if (admins.c <= 1) {
      res.status(400).json({ error: 'This is the only active admin account' });
      return;
    }
  }

  db.prepare(
    `UPDATE users SET is_admin = ?, is_disabled = ?, upload_quota_bytes = ?, display_name = ?,
      password_hash = ? WHERE id = ?`
  ).run(
    d.isAdmin !== undefined ? (d.isAdmin ? 1 : 0) : target.is_admin,
    d.isDisabled !== undefined ? (d.isDisabled ? 1 : 0) : target.is_disabled,
    d.quotaGb !== undefined ? (d.quotaGb === null ? null : Math.round(d.quotaGb * GB)) : target.upload_quota_bytes,
    d.displayName ?? target.display_name,
    d.newPassword ? hashPassword(d.newPassword) : target.password_hash,
    target.id
  );
  // A reset or a suspension must kick the account out of any live session.
  if (d.newPassword || d.isDisabled === true) revokeSessions(target.id);
  res.json({ ok: true });
});

adminRouter.delete('/users/:id', (req, res) => {
  if (req.params.id === req.user!.id) {
    res.status(400).json({ error: 'You cannot delete your own account' });
    return;
  }
  const uploads = db.prepare('SELECT stored_name FROM uploads WHERE owner_id = ?').all(req.params.id) as Array<{
    stored_name: string;
  }>;
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  deleteAvatarFiles(req.params.id);
  for (const u of uploads) {
    fs.promises.unlink(path.join(config.uploadDir, path.basename(u.stored_name))).catch(() => undefined);
  }
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Settings + overview                                                 */
/* ------------------------------------------------------------------ */

adminRouter.get('/settings', (req, res) => {
  const settings = allSettings();
  res.json({
    settings: {
      ...settings,
      // Never send the full key back to the browser.
      youtube_api_key: settings.youtube_api_key ? `${settings.youtube_api_key.slice(0, 6)}••••••` : '',
    },
    youtubeKeyFromEnv: Boolean(config.youtubeApiKeyEnv),
    hasYoutubeKey: Boolean(settings.youtube_api_key || config.youtubeApiKeyEnv),
    storage: storageStats(req.user!.id),
  });
});

const settingsSchema = z.object({
  site_name: z.string().trim().min(1).max(60).optional(),
  registration_open: z.boolean().optional(),
  youtube_api_key: z.string().trim().max(200).optional(),
  upload_enabled: z.boolean().optional(),
  upload_global_limit_gb: z.number().min(0).max(1000000).optional(),
  upload_default_user_quota_gb: z.number().min(0).max(1000000).optional(),
  max_upload_size_gb: z.number().min(0.1).max(1000).optional(),
  chat_history_limit: z.number().int().min(20).max(5000).optional(),
});

adminRouter.patch('/settings', (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid setting' });
    return;
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    // An empty string means "leave the stored key alone" (the UI shows a mask).
    if (key === 'youtube_api_key' && value === '') continue;
    setSetting(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  res.json({ ok: true });
});

adminRouter.post('/settings/clear-youtube-key', (_req, res) => {
  setSetting('youtube_api_key', '');
  res.json({ ok: true });
});

adminRouter.get('/overview', (req, res) => {
  const counts = {
    users: (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c,
    rooms: (db.prepare('SELECT COUNT(*) AS c FROM rooms').get() as { c: number }).c,
    playlists: (db.prepare('SELECT COUNT(*) AS c FROM playlists').get() as { c: number }).c,
    queueItems: (db.prepare('SELECT COUNT(*) AS c FROM queue_items').get() as { c: number }).c,
    messages: (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c,
    uploads: (db.prepare('SELECT COUNT(*) AS c FROM uploads').get() as { c: number }).c,
    activeCodes: (
      db.prepare(
        'SELECT COUNT(*) AS c FROM invite_codes WHERE revoked = 0 AND (max_uses = 0 OR uses < max_uses)'
      ).get() as { c: number }
    ).c,
  };
  const rooms = db
    .prepare(
      `SELECT r.id, r.name, r.is_public, r.updated_at, u.display_name AS owner,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id) AS members
       FROM rooms r LEFT JOIN users u ON u.id = r.owner_id ORDER BY r.updated_at DESC LIMIT 50`
    )
    .all() as Array<Record<string, unknown>>;

  res.json({ counts, rooms, storage: storageStats(req.user!.id), watch: globalStats() });
});

/* ------------------------------------------------------------------ */
/* Login back-off                                                      */
/* ------------------------------------------------------------------ */

adminRouter.get('/lockouts', (_req, res) => {
  res.json({ lockouts: activeLockouts() });
});

adminRouter.delete('/lockouts/:key', (req, res) => {
  clearLockout(decodeURIComponent(req.params.key));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Backup and restore                                                  */
/* ------------------------------------------------------------------ */

const backupSchema = z.object({
  includeUploads: z.boolean().optional(),
  passphrase: z.string().min(8).max(200).optional(),
});

adminRouter.post('/backup', async (req, res) => {
  const parsed = backupSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'A backup password must be at least 8 characters' });
    return;
  }

  try {
    const result = await createBackup({
      includeUploads: Boolean(parsed.data.includeUploads),
      passphrase: parsed.data.passphrase,
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `watch-with-friends-${stamp}${parsed.data.passphrase ? '-encrypted' : ''}.wwfbak`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-Backup-Manifest', Buffer.from(JSON.stringify(result.manifest.counts)).toString('base64'));
    res.sendFile(result.file, (err) => {
      result.cleanup();
      if (err && !res.headersSent) res.status(500).json({ error: 'Backup failed while sending' });
    });
  } catch (err) {
    console.error('[backup]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
  }
});

// Backups can be large, so they stage on disk rather than in memory.
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.tmpDir),
    filename: (_req, _file, cb) => cb(null, `upload-${Date.now()}.wwfbak`),
  }),
  limits: { fileSize: 64 * 1024 * 1024 * 1024, files: 1 },
});

adminRouter.post('/restore', (req, res) => {
  restoreUpload.single('file')(req, res, async (uploadErr: unknown) => {
    const file = req.file;
    const cleanup = () => {
      if (file?.path) fs.promises.unlink(file.path).catch(() => undefined);
    };
    if (uploadErr || !file) {
      cleanup();
      res.status(400).json({ error: 'No backup file received' });
      return;
    }
    try {
      const passphrase = typeof req.body?.passphrase === 'string' && req.body.passphrase ? req.body.passphrase : undefined;
      const preview = await stageRestore(file.path, passphrase);
      res.json({
        staged: true,
        manifest: preview.manifest,
        message: 'Backup checked and staged. Restart the container to apply it.',
      });
    } catch (err) {
      res.status(err instanceof BackupError ? 400 : 500).json({
        error: err instanceof Error ? err.message : 'Restore failed',
      });
    } finally {
      cleanup();
    }
  });
});

adminRouter.get('/restore', (_req, res) => {
  res.json({ pending: pendingRestore() });
});

adminRouter.delete('/restore', (_req, res) => {
  cancelRestore();
  res.json({ ok: true });
});

adminRouter.delete('/rooms/:id', (req, res) => {
  kickUser(req.params.id, null, 'This room was deleted by an administrator');
  db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  forgetRoom(req.params.id);
  res.json({ ok: true });
});
