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

    // "3 of 12" reads better than a raw id. An item played from a hand-built
    // queue rather than the playlist itself simply has no index.
    const hit = db
      .prepare('SELECT MIN(sort) AS sort FROM playlist_items WHERE playlist_id = ? AND source = ? AND source_id = ?')
      .get(playlistId, item.source, item.sourceId) as { sort: number | null };
    const index =
      hit.sort == null
        ? 0
        : (
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
