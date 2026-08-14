import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const dir of [DATA_DIR, UPLOAD_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * The session secret must survive restarts, otherwise everybody gets logged out
 * on every container update. Prefer the env var, fall back to a generated file.
 */
function resolveSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const keyFile = path.join(DATA_DIR, 'session.key');
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  port: envInt('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  uploadDir: UPLOAD_DIR,
  tmpDir: TMP_DIR,
  dbFile: path.join(DATA_DIR, 'wwf.db'),
  sessionSecret: resolveSessionSecret(),
  sessionDays: envInt('SESSION_DAYS', 30),
  /** Behind a Cloudflare tunnel / reverse proxy we must trust X-Forwarded-*. */
  trustProxy: process.env.TRUST_PROXY !== 'false',
  /** Bootstrap admin, only used when the user table is empty. */
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  youtubeApiKeyEnv: process.env.YOUTUBE_API_KEY || '',
  isProduction: process.env.NODE_ENV === 'production',
  /** Absolute path to built client assets (only used in production). */
  clientDir: path.resolve(process.env.CLIENT_DIR || path.join(__dirname, '..', '..', 'client', 'dist')),
};

export type Config = typeof config;
