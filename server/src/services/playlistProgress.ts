/**
 * Remembers how far a group got through a playlist.
 *
 * Progress belongs to the playlist, not to a person or a room: the whole point
 * is that everyone picks up together next time, whoever presses play.
 */

import { db } from '../db';
import { createLogger } from './logger';

const log = createLogger('playlist');

export interface PlaylistProgress {
  playlistId: string;
  source: string;
  sourceId: string;
  title: string;
  position: number;
  itemIndex: number;
  itemCount: number;
  updatedAt: number;
  updatedBy: string | null;
}

interface Row {
  playlist_id: string;
  source: string;
  source_id: string;
  title: string;
  position: number;
  item_index: number;
  item_count: number;
  updated_at: number;
  updated_by: string | null;
}

function toDTO(row: Row): PlaylistProgress {
  return {
    playlistId: row.playlist_id,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    position: row.position,
    itemIndex: row.item_index,
    itemCount: row.item_count,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function progressFor(playlistId: string): PlaylistProgress | null {
  const row = db.prepare('SELECT * FROM playlist_progress WHERE playlist_id = ?').get(playlistId) as Row | undefined;
  return row ? toDTO(row) : null;
}

/** Bulk lookup for the playlist list, so it does not fire one query per card. */
export function progressForMany(playlistIds: string[]): Map<string, PlaylistProgress> {
  const out = new Map<string, PlaylistProgress>();
  if (playlistIds.length === 0) return out;
  const holes = playlistIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM playlist_progress WHERE playlist_id IN (${holes})`)
    .all(...playlistIds) as Row[];
  for (const row of rows) out.set(row.playlist_id, toDTO(row));
  return out;
}

/**
 * Record where the room is. Called from the playback heartbeat, so it must stay
 * cheap and must never throw into the tick.
 */
export function recordProgress(
  playlistId: string,
  item: { source: string; sourceId: string; title: string },
  position: number,
  updatedBy?: string | null
): void {
  try {
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get(playlistId) as { n: number }
    ).n;

    // "3 of 12" reads better than a raw id.
    const hit = db
      .prepare('SELECT MIN(sort) AS sort FROM playlist_items WHERE playlist_id = ? AND source = ? AND source_id = ?')
      .get(playlistId, item.source, item.sourceId) as { sort: number | null };
    // A video queued by hand while the playlist was loaded is not part of it,
    // and must not overwrite where the group actually got to.
    if (hit.sort == null) return;
    const index = (
      db
        .prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ? AND sort <= ?')
        .get(playlistId, hit.sort) as { n: number }
    ).n;

    db.prepare(
      `INSERT INTO playlist_progress
         (playlist_id, source, source_id, title, position, item_index, item_count, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(playlist_id) DO UPDATE SET
         source = excluded.source, source_id = excluded.source_id, title = excluded.title,
         position = excluded.position, item_index = excluded.item_index, item_count = excluded.item_count,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).run(
      playlistId,
      item.source,
      item.sourceId,
      item.title.slice(0, 300),
      Math.max(0, position),
      index,
      total,
      Date.now(),
      updatedBy ?? null
    );
  } catch (err) {
    log.warn('could not record progress', {
      playlist: playlistId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function resetProgress(playlistId: string): void {
  db.prepare('DELETE FROM playlist_progress WHERE playlist_id = ?').run(playlistId);
  log.info('progress reset', { playlist: playlistId });
}

/** Rooms remember which playlist they are working through. */
export function setRoomPlaylist(roomId: string, playlistId: string | null): void {
  db.prepare('UPDATE rooms SET playlist_id = ? WHERE id = ?').run(playlistId, roomId);
}

export function roomPlaylistId(roomId: string): string | null {
  const row = db.prepare('SELECT playlist_id FROM rooms WHERE id = ?').get(roomId) as
    | { playlist_id: string | null }
    | undefined;
  return row?.playlist_id ?? null;
}

/* ------------------------------------------------------------------ */
/* Per episode                                                         */
/* ------------------------------------------------------------------ */

/** Seen this much of an episode and it counts as watched - credits and all. */
const WATCHED_SHARE = 0.9;

export interface EpisodeProgress {
  position: number;
  watched: boolean;
}

/** Heartbeat: where the group is inside this episode. Never throws into the tick. */
export function recordEpisode(playlistId: string, itemId: string, position: number, duration: number | null): void {
  try {
    const seen = duration && duration > 0 && position >= duration * WATCHED_SHARE ? 1 : 0;
    db.prepare(
      `INSERT INTO playlist_item_progress (item_id, playlist_id, position, watched, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM playlist_items WHERE id = ? AND playlist_id = ?)
       ON CONFLICT(item_id) DO UPDATE SET
         position = excluded.position,
         -- once watched, a rewatch does not make it unwatched again
         watched = MAX(watched, excluded.watched),
         updated_at = excluded.updated_at`
    ).run(itemId, playlistId, Math.max(0, position), seen, Date.now(), itemId, playlistId);
  } catch (err) {
    log.warn('could not record episode progress', {
      item: itemId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The player reached the end of it: watched, and nothing left to resume. */
export function markWatched(playlistId: string, itemId: string): void {
  db.prepare(
    `INSERT INTO playlist_item_progress (item_id, playlist_id, position, watched, updated_at)
     SELECT ?, ?, 0, 1, ? WHERE EXISTS (SELECT 1 FROM playlist_items WHERE id = ? AND playlist_id = ?)
     ON CONFLICT(item_id) DO UPDATE SET position = 0, watched = 1, updated_at = excluded.updated_at`
  ).run(itemId, playlistId, Date.now(), itemId, playlistId);
}

export function episodeProgress(playlistId: string): Map<string, EpisodeProgress> {
  const rows = db
    .prepare('SELECT item_id, position, watched FROM playlist_item_progress WHERE playlist_id = ?')
    .all(playlistId) as Array<{ item_id: string; position: number; watched: number }>;
  return new Map(rows.map((r) => [r.item_id, { position: r.position, watched: r.watched === 1 }]));
}

export function watchedCounts(playlistIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (playlistIds.length === 0) return out;
  const holes = playlistIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT playlist_id, COUNT(*) AS n FROM playlist_item_progress
        WHERE watched = 1 AND playlist_id IN (${holes}) GROUP BY playlist_id`
    )
    .all(...playlistIds) as Array<{ playlist_id: string; n: number }>;
  for (const r of rows) out.set(r.playlist_id, r.n);
  return out;
}

/** Wipe the watched marks too - "we have not seen any of this". */
export function forgetEpisodes(playlistId: string): void {
  db.prepare('DELETE FROM playlist_item_progress WHERE playlist_id = ?').run(playlistId);
}
