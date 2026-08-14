import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import { db } from './db';
import type { PublicUser, UserRow } from './types';

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: parseInt(n, 10),
      r: parseInt(r, 10),
      p: parseInt(p, 10),
    });
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export function newId(bytes = 12): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export const SESSION_COOKIE = 'wwf_session';

export function issueSession(res: Response, userId: string, req: Request): void {
  const token = jwt.sign({ sub: userId }, config.sessionSecret, {
    expiresIn: `${config.sessionDays}d`,
  });
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const isHttps = req.secure || forwardedProto === 'https';
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function toPublicUser(row: UserRow): PublicUser {
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(row.prefs) as Record<string, unknown>;
  } catch {
    prefs = {};
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    avatarColor: row.avatar_color,
    prefs,
    createdAt: row.created_at,
  };
}

export function userFromToken(token: string | undefined): PublicUser | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.sessionSecret) as { sub?: string };
    if (!payload.sub) return null;
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) as UserRow | undefined;
    if (!row || row.is_disabled === 1) return null;
    return toPublicUser(row);
  } catch {
    return null;
  }
}

/** Populates req.user when a valid session cookie is present. Never rejects. */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  const user = userFromToken(token);
  if (user) req.user = user;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  next();
}

export interface BootstrapResult {
  /** Set when an account was created and we invented the password. */
  created?: { username: string; password: string };
  /** Set when ADMIN_* were supplied but the database already had accounts. */
  ignoredEnv?: { username: string; existing: string[] };
}

/**
 * Creates the first admin when the database is empty so a fresh deployment is
 * never locked out.
 *
 * ADMIN_USERNAME / ADMIN_PASSWORD deliberately do nothing once accounts exist -
 * otherwise anyone who could edit the compose file could silently take over an
 * existing account. Say so loudly, because setting them later and getting no
 * feedback is baffling.
 */
export function ensureBootstrapAdmin(): BootstrapResult {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };

  if (count.c > 0) {
    if (config.adminPassword) {
      const existing = (db.prepare('SELECT username FROM users ORDER BY created_at').all() as Array<{
        username: string;
      }>).map((r) => r.username);
      return { ignoredEnv: { username: config.adminUsername, existing } };
    }
    return {};
  }

  const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, is_admin, avatar_color, prefs, created_at)
     VALUES (?, ?, ?, ?, 1, ?, '{}', ?)`
  ).run(newId(), config.adminUsername, config.adminUsername, hashPassword(password), '#7c5cff', now);

  return config.adminPassword ? {} : { created: { username: config.adminUsername, password } };
}
