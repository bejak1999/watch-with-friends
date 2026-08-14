import { Router } from 'express';
import { z } from 'zod';
import { db, getSettingBool } from '../db';
import {
  SESSION_COOKIE,
  clearSession,
  hashPassword,
  issueSession,
  newId,
  requireAuth,
  toPublicUser,
  verifyPassword,
} from '../auth';
import type { UserRow } from '../types';

export const authRouter = Router();

const AVATAR_COLORS = [
  '#7c5cff', '#f472b6', '#38bdf8', '#34d399', '#fbbf24',
  '#fb7185', '#a78bfa', '#22d3ee', '#4ade80', '#f97316',
];

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username must be at most 24 characters')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, numbers and _ . - are allowed');

const registerSchema = z.object({
  code: z.string().trim().min(4),
  username: usernameSchema,
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

authRouter.post('/register', (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  if (!getSettingBool('registration_open')) {
    res.status(403).json({ error: 'Registration is currently disabled' });
    return;
  }

  const { username, password } = parsed.data;
  const code = normaliseCode(parsed.data.code);

  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as
    | {
        code: string;
        expires_at: number | null;
        max_uses: number;
        uses: number;
        revoked: number;
        grants_admin: number;
      }
    | undefined;

  if (!invite || invite.revoked === 1) {
    res.status(400).json({ error: 'Unknown or revoked registration code' });
    return;
  }
  if (invite.expires_at && invite.expires_at < Date.now()) {
    res.status(400).json({ error: 'This registration code has expired' });
    return;
  }
  if (invite.max_uses > 0 && invite.uses >= invite.max_uses) {
    res.status(400).json({ error: 'This registration code has already been used' });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    res.status(409).json({ error: 'That username is taken' });
    return;
  }

  const id = newId();
  const now = Date.now();
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, is_admin, avatar_color, prefs, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`
    ).run(id, username, username, hashPassword(password), invite.grants_admin, color, now, now);
    db.prepare('UPDATE invite_codes SET uses = uses + 1 WHERE code = ?').run(code);
    db.prepare('INSERT INTO invite_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)').run(code, id, now);
  });
  tx();

  issueSession(res, id, req);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  res.json({ user: toPublicUser(row) });
});

authRouter.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Enter a username and password' });
    return;
  }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(parsed.data.username) as UserRow | undefined;
  if (!row || !verifyPassword(parsed.data.password, row.password_hash)) {
    res.status(401).json({ error: 'Wrong username or password' });
    return;
  }
  if (row.is_disabled === 1) {
    res.status(403).json({ error: 'This account has been disabled' });
    return;
  }
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
  issueSession(res, row.id, req);
  res.json({ user: toPublicUser(row) });
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ?? null, registrationOpen: getSettingBool('registration_open') });
});

/** Lets the register screen show "code looks good" before the form is filled in. */
authRouter.post('/check-code', (req, res) => {
  const code = normaliseCode(String((req.body as { code?: string })?.code || ''));
  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as
    | { expires_at: number | null; max_uses: number; uses: number; revoked: number }
    | undefined;
  if (!invite || invite.revoked === 1) {
    res.json({ valid: false, reason: 'Unknown code' });
    return;
  }
  if (invite.expires_at && invite.expires_at < Date.now()) {
    res.json({ valid: false, reason: 'Expired' });
    return;
  }
  if (invite.max_uses > 0 && invite.uses >= invite.max_uses) {
    res.json({ valid: false, reason: 'Already used' });
    return;
  }
  res.json({ valid: true });
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(32).optional(),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  prefs: z.record(z.unknown()).optional(),
});

authRouter.patch('/me', requireAuth, (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid profile update' });
    return;
  }
  const user = req.user!;
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
  const prefs = parsed.data.prefs
    ? JSON.stringify({ ...JSON.parse(current.prefs || '{}'), ...parsed.data.prefs })
    : current.prefs;

  db.prepare('UPDATE users SET display_name = ?, avatar_color = ?, prefs = ? WHERE id = ?').run(
    parsed.data.displayName ?? current.display_name,
    parsed.data.avatarColor ?? current.avatar_color,
    prefs,
    user.id
  );
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow;
  res.json({ user: toPublicUser(row) });
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

authRouter.post('/change-password', requireAuth, (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'New password must be at least 8 characters' });
    return;
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as UserRow;
  if (!verifyPassword(parsed.data.currentPassword, row.password_hash)) {
    res.status(403).json({ error: 'Current password is wrong' });
    return;
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(parsed.data.newPassword), row.id);
  // Re-issue so the cookie lifetime resets.
  issueSession(res, row.id, req);
  res.json({ ok: true });
});

export { SESSION_COOKIE };
