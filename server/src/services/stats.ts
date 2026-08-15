import { db } from '../db';
import { newId } from '../auth';

/**
 * Watch time is credited from the server tick rather than reported by clients:
 * a browser could claim any number, and a paused or buffering viewer is not
 * really watching. Seconds land in per-day buckets so trends stay cheap.
 */

/** Local calendar day, so "today" matches the household's clock. */
export function dayKey(at = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function creditWatchTime(roomId: string, userIds: Iterable<string>, seconds: number): void {
  const day = dayKey();
  const stmt = db.prepare(
    `INSERT INTO watch_stats (user_id, room_id, day, seconds) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, room_id, day) DO UPDATE SET seconds = seconds + excluded.seconds`
  );
  const tx = db.transaction(() => {
    for (const userId of userIds) stmt.run(userId, roomId, day, seconds);
  });
  tx();
}

export function logPlay(roomId: string, title: string, source: string, addedBy: string | null): void {
  db.prepare('INSERT INTO play_log (id, room_id, title, source, added_by, played_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    newId(),
    roomId,
    title.slice(0, 300),
    source,
    addedBy,
    Date.now()
  );
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

function lastDays(count: number): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  return days;
}

export interface DailyPoint {
  day: string;
  seconds: number;
}

/** Zero-filled so the chart has no gaps on quiet days. */
function fillDaily(rows: Array<{ day: string; seconds: number }>, count = 14): DailyPoint[] {
  const map = new Map(rows.map((r) => [r.day, r.seconds]));
  return lastDays(count).map((day) => ({ day, seconds: map.get(day) ?? 0 }));
}

export function personalStats(userId: string) {
  const totals = db
    .prepare('SELECT COALESCE(SUM(seconds),0) AS seconds, COUNT(DISTINCT room_id) AS rooms FROM watch_stats WHERE user_id = ?')
    .get(userId) as { seconds: number; rooms: number };

  const daily = db
    .prepare('SELECT day, SUM(seconds) AS seconds FROM watch_stats WHERE user_id = ? GROUP BY day ORDER BY day')
    .all(userId) as Array<{ day: string; seconds: number }>;

  const added = db.prepare('SELECT COUNT(*) AS c FROM queue_items WHERE added_by = ?').get(userId) as { c: number };
  const messages = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?').get(userId) as { c: number };
  const playlists = db.prepare('SELECT COUNT(*) AS c FROM playlists WHERE owner_id = ?').get(userId) as { c: number };

  const perRoom = db
    .prepare(
      `SELECT w.room_id AS roomId, r.name AS name, SUM(w.seconds) AS seconds
       FROM watch_stats w JOIN rooms r ON r.id = w.room_id
       WHERE w.user_id = ? GROUP BY w.room_id ORDER BY seconds DESC LIMIT 12`
    )
    .all(userId) as Array<{ roomId: string; name: string; seconds: number }>;

  const sources = db
    .prepare(
      `SELECT source, COUNT(*) AS count FROM queue_items WHERE added_by = ?
       GROUP BY source ORDER BY count DESC`
    )
    .all(userId) as Array<{ source: string; count: number }>;

  return {
    totalSeconds: totals.seconds,
    rooms: totals.rooms,
    videosAdded: added.c,
    messages: messages.c,
    playlists: playlists.c,
    daily: fillDaily(daily),
    perRoom,
    sources,
  };
}

export function roomStats(roomId: string) {
  const totals = db
    .prepare('SELECT COALESCE(SUM(seconds),0) AS seconds, COUNT(DISTINCT user_id) AS watchers FROM watch_stats WHERE room_id = ?')
    .get(roomId) as { seconds: number; watchers: number };

  const played = db.prepare('SELECT COUNT(*) AS c FROM play_log WHERE room_id = ?').get(roomId) as { c: number };
  const messages = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE room_id = ? AND kind = ?').get(
    roomId,
    'chat'
  ) as { c: number };

  const leaderboard = db
    .prepare(
      `SELECT u.id AS userId, u.display_name AS displayName, u.avatar_color AS avatarColor,
              u.avatar_updated_at AS avatarUpdatedAt, SUM(w.seconds) AS seconds
       FROM watch_stats w JOIN users u ON u.id = w.user_id
       WHERE w.room_id = ? GROUP BY w.user_id ORDER BY seconds DESC LIMIT 20`
    )
    .all(roomId) as Array<{
    userId: string;
    displayName: string;
    avatarColor: string;
    avatarUpdatedAt: number | null;
    seconds: number;
  }>;

  const daily = db
    .prepare('SELECT day, SUM(seconds) AS seconds FROM watch_stats WHERE room_id = ? GROUP BY day ORDER BY day')
    .all(roomId) as Array<{ day: string; seconds: number }>;

  const sources = db
    .prepare('SELECT source, COUNT(*) AS count FROM play_log WHERE room_id = ? GROUP BY source ORDER BY count DESC')
    .all(roomId) as Array<{ source: string; count: number }>;

  const recent = db
    .prepare('SELECT title, source, played_at AS playedAt FROM play_log WHERE room_id = ? ORDER BY played_at DESC LIMIT 15')
    .all(roomId) as Array<{ title: string; source: string; playedAt: number }>;

  return {
    totalSeconds: totals.seconds,
    watchers: totals.watchers,
    videosPlayed: played.c,
    messages: messages.c,
    leaderboard: leaderboard.map((l) => ({
      ...l,
      avatarUrl: l.avatarUpdatedAt ? `/api/users/${l.userId}/avatar?v=${l.avatarUpdatedAt}` : null,
    })),
    daily: fillDaily(daily),
    sources,
    recent,
  };
}

/** Server-wide figures for the admin overview. */
export function globalStats() {
  const total = db.prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM watch_stats').get() as { s: number };
  const today = db.prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM watch_stats WHERE day = ?').get(dayKey()) as {
    s: number;
  };
  const played = db.prepare('SELECT COUNT(*) AS c FROM play_log').get() as { c: number };
  const topUsers = db
    .prepare(
      `SELECT u.display_name AS displayName, SUM(w.seconds) AS seconds
       FROM watch_stats w JOIN users u ON u.id = w.user_id
       GROUP BY w.user_id ORDER BY seconds DESC LIMIT 10`
    )
    .all() as Array<{ displayName: string; seconds: number }>;
  return { totalSeconds: total.s, todaySeconds: today.s, videosPlayed: played.c, topUsers };
}
