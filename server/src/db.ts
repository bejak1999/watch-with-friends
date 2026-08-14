import Database from 'better-sqlite3';
import { config } from './config';

export const db = new Database(config.dbFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const MIGRATIONS: Array<(d: Database.Database) => void> = [];

MIGRATIONS.push((d) => {
  d.exec(`
    CREATE TABLE users (
      id                 TEXT PRIMARY KEY,
      username           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name       TEXT NOT NULL,
      password_hash      TEXT NOT NULL,
      is_admin           INTEGER NOT NULL DEFAULT 0,
      is_disabled        INTEGER NOT NULL DEFAULT 0,
      avatar_color       TEXT NOT NULL DEFAULT '#6366f1',
      prefs              TEXT NOT NULL DEFAULT '{}',
      upload_quota_bytes INTEGER,
      created_at         INTEGER NOT NULL,
      last_login_at      INTEGER
    );

    CREATE TABLE invite_codes (
      code         TEXT PRIMARY KEY,
      created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER,
      max_uses     INTEGER NOT NULL DEFAULT 1,
      uses         INTEGER NOT NULL DEFAULT 0,
      note         TEXT,
      revoked      INTEGER NOT NULL DEFAULT 0,
      grants_admin INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE invite_redemptions (
      code      TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      redeemed_at INTEGER NOT NULL
    );

    CREATE TABLE rooms (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      topic           TEXT,
      owner_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
      invite_token    TEXT NOT NULL UNIQUE,
      is_public       INTEGER NOT NULL DEFAULT 0,
      control_mode    TEXT NOT NULL DEFAULT 'everyone',
      queue_mode      TEXT NOT NULL DEFAULT 'everyone',
      wait_for_buffer INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      current_item_id TEXT,
      position        REAL NOT NULL DEFAULT 0,
      is_playing      INTEGER NOT NULL DEFAULT 0,
      rate            REAL NOT NULL DEFAULT 1,
      state_at        INTEGER NOT NULL DEFAULT 0,
      repeat_mode     TEXT NOT NULL DEFAULT 'off',
      shuffle         INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE room_members (
      room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role         TEXT NOT NULL DEFAULT 'member',
      joined_at    INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      banned       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE queue_items (
      id        TEXT PRIMARY KEY,
      room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      sort      REAL NOT NULL,
      source    TEXT NOT NULL,
      source_id TEXT NOT NULL,
      url       TEXT,
      title     TEXT NOT NULL,
      author    TEXT,
      duration  REAL,
      thumbnail TEXT,
      added_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      added_at  INTEGER NOT NULL,
      played_at INTEGER
    );
    CREATE INDEX idx_queue_room ON queue_items(room_id, sort);

    CREATE TABLE playlists (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      is_shared   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE playlist_items (
      id          TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      sort        REAL NOT NULL,
      source      TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      url         TEXT,
      title       TEXT NOT NULL,
      author      TEXT,
      duration    REAL,
      thumbnail   TEXT
    );
    CREATE INDEX idx_pl_items ON playlist_items(playlist_id, sort);

    CREATE TABLE messages (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind       TEXT NOT NULL DEFAULT 'chat',
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_room ON messages(room_id, created_at);

    CREATE TABLE uploads (
      id            TEXT PRIMARY KEY,
      owner_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime          TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
});

MIGRATIONS.push((d) => {
  d.exec(`
    CREATE TABLE login_attempts (
      key              TEXT PRIMARY KEY,
      failures         INTEGER NOT NULL DEFAULT 0,
      first_failure_at INTEGER NOT NULL,
      last_failure_at  INTEGER NOT NULL,
      locked_until     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_login_attempts_last ON login_attempts(last_failure_at);
  `);
});

export function migrate(): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v];
    const run = db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${v + 1}`);
    });
    run();
    console.log(`[db] applied migration ${v + 1}`);
  }
}

/* ------------------------------------------------------------------ */
/* settings helpers                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS: Record<string, string> = {
  site_name: 'Watch With Friends',
  registration_open: '1',
  youtube_api_key: '',
  upload_enabled: '1',
  upload_global_limit_gb: '50',
  upload_default_user_quota_gb: '5',
  max_upload_size_gb: '4',
  chat_history_limit: '300',
};

export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (row) return row.value;
  return DEFAULT_SETTINGS[key] ?? '';
}

export function getSettingNumber(key: string): number {
  const n = parseFloat(getSetting(key));
  return Number.isFinite(n) ? n : 0;
}

export function getSettingBool(key: string): boolean {
  const v = getSetting(key);
  return v === '1' || v === 'true';
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function allSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
