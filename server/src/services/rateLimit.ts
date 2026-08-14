import type { Request } from 'express';
import { db } from '../db';

/**
 * Exponential back-off for credential guessing.
 *
 * The first few mistakes are free so a genuine typo costs nothing. After that
 * each additional failure doubles the wait, up to a cap. Counters are stored in
 * SQLite so a container restart cannot be used to wipe them, and they decay on
 * their own once an attacker gives up.
 */

/** Mistakes allowed before any delay kicks in. */
const FREE_ATTEMPTS = 3;
/** Wait after the first non-free failure. Doubles from here. */
const BASE_DELAY_MS = 2_000;
/** Upper bound, so a locked-out friend is never stuck for long. */
const MAX_DELAY_MS = 15 * 60 * 1000;
/** A quiet period this long resets the counter completely. */
const DECAY_MS = 60 * 60 * 1000;

export interface LimitStatus {
  blocked: boolean;
  /** Milliseconds until the next attempt is allowed. */
  retryAfterMs: number;
  failures: number;
}

const OK: LimitStatus = { blocked: false, retryAfterMs: 0, failures: 0 };

interface AttemptRow {
  key: string;
  failures: number;
  first_failure_at: number;
  last_failure_at: number;
  locked_until: number;
}

function readRow(key: string, now: number): AttemptRow | undefined {
  const row = db.prepare('SELECT * FROM login_attempts WHERE key = ?').get(key) as AttemptRow | undefined;
  if (!row) return undefined;
  if (now - row.last_failure_at > DECAY_MS) {
    db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
    return undefined;
  }
  return row;
}

function lockoutFor(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  const steps = failures - FREE_ATTEMPTS - 1;
  return Math.min(BASE_DELAY_MS * 2 ** steps, MAX_DELAY_MS);
}

/** Worst-case status across every key guarding this request. */
export function checkLimit(keys: string[]): LimitStatus {
  const now = Date.now();
  let worst = OK;
  for (const key of keys) {
    const row = readRow(key, now);
    if (!row) continue;
    const remaining = row.locked_until - now;
    if (remaining > 0 && remaining > worst.retryAfterMs) {
      worst = { blocked: true, retryAfterMs: remaining, failures: row.failures };
    }
  }
  return worst;
}

export function recordFailure(keys: string[]): LimitStatus {
  const now = Date.now();
  let worst = OK;

  const tx = db.transaction(() => {
    for (const key of keys) {
      const row = readRow(key, now);
      const failures = (row?.failures ?? 0) + 1;
      const lockMs = lockoutFor(failures);
      const lockedUntil = lockMs > 0 ? now + lockMs : 0;

      db.prepare(
        `INSERT INTO login_attempts (key, failures, first_failure_at, last_failure_at, locked_until)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           failures = excluded.failures,
           last_failure_at = excluded.last_failure_at,
           locked_until = excluded.locked_until`
      ).run(key, failures, row?.first_failure_at ?? now, now, lockedUntil);

      if (lockMs > worst.retryAfterMs) {
        worst = { blocked: lockMs > 0, retryAfterMs: lockMs, failures };
      }
    }
  });
  tx();

  return worst;
}

export function clearFailures(keys: string[]): void {
  const stmt = db.prepare('DELETE FROM login_attempts WHERE key = ?');
  const tx = db.transaction(() => {
    for (const key of keys) stmt.run(key);
  });
  tx();
}

/**
 * Best-effort client address.
 *
 * With `trust proxy` enabled Express returns the *left-most* X-Forwarded-For
 * entry, which the client itself can forge. Cloudflare overwrites
 * CF-Connecting-IP at its edge, so prefer that; otherwise fall back to the
 * right-most forwarded hop, which is the one our own proxy appended.
 */
export function clientAddress(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const forwarded = req.headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (chain) {
    const hops = chain.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

export function userKey(username: string): string {
  return `u:${username.trim().toLowerCase()}`;
}

export function ipKey(req: Request, scope: string): string {
  return `ip:${scope}:${clientAddress(req)}`;
}

export function formatRetry(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ */
/* Admin visibility                                                    */
/* ------------------------------------------------------------------ */

export function activeLockouts() {
  const now = Date.now();
  // Anything older than the decay window is already dead, just not swept yet.
  const rows = db
    .prepare('SELECT * FROM login_attempts WHERE last_failure_at > ? ORDER BY last_failure_at DESC LIMIT 100')
    .all(now - DECAY_MS) as AttemptRow[];

  return rows.map((r) => ({
      key: r.key,
      kind: r.key.startsWith('u:') ? 'account' : 'address',
      label: r.key.replace(/^u:/, '').replace(/^ip:[^:]+:/, ''),
      failures: r.failures,
      lockedUntil: r.locked_until,
      lockedForMs: Math.max(0, r.locked_until - now),
      lastFailureAt: r.last_failure_at,
    }));
}

/** Drops decayed rows so the table cannot grow without bound. */
export function sweepExpired(): void {
  db.prepare('DELETE FROM login_attempts WHERE last_failure_at < ?').run(Date.now() - DECAY_MS);
}

export function clearLockout(key: string): void {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}
