import { db, getSettingNumber } from '../db';
import { newId } from '../auth';
import type { MediaItem, PublicUser, QueueItemRow, RoomRole, RoomRow } from '../types';

export interface QueueItemDTO {
  id: string;
  source: string;
  sourceId: string;
  url: string | null;
  title: string;
  author: string | null;
  duration: number | null;
  thumbnail: string | null;
  addedBy: string | null;
  addedByName: string | null;
  addedAt: number;
  playedAt: number | null;
}

export interface RoomSummary {
  id: string;
  name: string;
  topic: string | null;
  ownerId: string | null;
  ownerName: string | null;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
  memberCount: number;
  onlineCount: number;
  queueCount: number;
  nowPlaying: string | null;
  thumbnail: string | null;
  myRole: RoomRole | null;
}

export function roomById(roomId: string): RoomRow | undefined {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | undefined;
}

export function roomByInviteToken(token: string): RoomRow | undefined {
  return db.prepare('SELECT * FROM rooms WHERE invite_token = ?').get(token) as RoomRow | undefined;
}

export function memberRole(roomId: string, userId: string): RoomRole | null {
  const row = db
    .prepare('SELECT role, banned FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, userId) as { role: RoomRole; banned: number } | undefined;
  if (!row || row.banned === 1) return null;
  return row.role;
}

export function isBanned(roomId: string, userId: string): boolean {
  const row = db
    .prepare('SELECT banned FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, userId) as { banned: number } | undefined;
  return row?.banned === 1;
}

export function joinRoom(roomId: string, userId: string, role: RoomRole = 'member'): RoomRole | null {
  if (isBanned(roomId, userId)) return null;
  const now = Date.now();
  const existing = memberRole(roomId, userId);
  if (existing) {
    db.prepare('UPDATE room_members SET last_seen_at = ? WHERE room_id = ? AND user_id = ?').run(now, roomId, userId);
    return existing;
  }
  db.prepare(
    `INSERT INTO room_members (room_id, user_id, role, joined_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(room_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  ).run(roomId, userId, role, now, now);
  return role;
}

export function canControl(room: RoomRow, user: PublicUser, role: RoomRole | null): boolean {
  if (user.isAdmin) return true;
  if (role === 'owner' || role === 'host') return true;
  return room.control_mode === 'everyone' && role !== null;
}

export function canQueue(room: RoomRow, user: PublicUser, role: RoomRole | null): boolean {
  if (user.isAdmin) return true;
  if (role === 'owner' || role === 'host') return true;
  return room.queue_mode === 'everyone' && role !== null;
}

export function canManageRoom(room: RoomRow, user: PublicUser, role: RoomRole | null): boolean {
  return user.isAdmin || role === 'owner' || room.owner_id === user.id;
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export function queueRows(roomId: string): QueueItemRow[] {
  return db.prepare('SELECT * FROM queue_items WHERE room_id = ? ORDER BY sort ASC').all(roomId) as QueueItemRow[];
}

export function queueDTO(roomId: string): QueueItemDTO[] {
  const rows = db
    .prepare(
      `SELECT q.*, u.display_name AS added_by_name
       FROM queue_items q LEFT JOIN users u ON u.id = q.added_by
       WHERE q.room_id = ? ORDER BY q.sort ASC`
    )
    .all(roomId) as Array<QueueItemRow & { added_by_name: string | null }>;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    url: r.url,
    title: r.title,
    author: r.author,
    duration: r.duration,
    thumbnail: r.thumbnail,
    addedBy: r.added_by,
    addedByName: r.added_by_name,
    addedAt: r.added_at,
    playedAt: r.played_at,
  }));
}

function nextSort(roomId: string): number {
  const row = db.prepare('SELECT MAX(sort) AS m FROM queue_items WHERE room_id = ?').get(roomId) as { m: number | null };
  return (row.m ?? 0) + 1;
}

export function addToQueue(roomId: string, userId: string, items: MediaItem[], atTop = false): QueueItemRow[] {
  const now = Date.now();
  const created: QueueItemRow[] = [];

  const tx = db.transaction(() => {
    let sort: number;
    let step = 1;
    if (atTop) {
      const first = db.prepare('SELECT MIN(sort) AS m FROM queue_items WHERE room_id = ?').get(roomId) as {
        m: number | null;
      };
      // Fit the batch into the gap before the current head.
      const head = first.m ?? 1;
      step = 1 / (items.length + 1);
      sort = head - 1 + step;
    } else {
      sort = nextSort(roomId);
    }

    for (const item of items) {
      const id = newId();
      db.prepare(
        `INSERT INTO queue_items (id, room_id, sort, source, source_id, url, title, author, duration, thumbnail, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        roomId,
        sort,
        item.source,
        item.sourceId,
        item.url ?? null,
        item.title.slice(0, 300),
        item.author ?? null,
        item.duration ?? null,
        item.thumbnail ?? null,
        userId,
        now
      );
      created.push(db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id) as QueueItemRow);
      sort += step;
    }
    db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(now, roomId);
  });
  tx();

  return created;
}

export function removeQueueItem(roomId: string, itemId: string): void {
  db.prepare('DELETE FROM queue_items WHERE room_id = ? AND id = ?').run(roomId, itemId);
}

export function clearQueue(roomId: string, keepCurrent: string | null): void {
  if (keepCurrent) {
    db.prepare('DELETE FROM queue_items WHERE room_id = ? AND id != ?').run(roomId, keepCurrent);
  } else {
    db.prepare('DELETE FROM queue_items WHERE room_id = ?').run(roomId);
  }
}

/** Moves an item so it lands at `toIndex` in the current ordering. */
export function moveQueueItem(roomId: string, itemId: string, toIndex: number): void {
  const rows = queueRows(roomId);
  const from = rows.findIndex((r) => r.id === itemId);
  if (from === -1) return;
  const [moved] = rows.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, rows.length));
  rows.splice(clamped, 0, moved);

  const tx = db.transaction(() => {
    rows.forEach((row, i) => {
      db.prepare('UPDATE queue_items SET sort = ? WHERE id = ?').run(i + 1, row.id);
    });
  });
  tx();
}

export function shuffleQueue(roomId: string, keepFirst: string | null): void {
  const rows = queueRows(roomId);
  const pinned = keepFirst ? rows.filter((r) => r.id === keepFirst) : [];
  const rest = rows.filter((r) => r.id !== keepFirst);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const ordered = [...pinned, ...rest];
  const tx = db.transaction(() => {
    ordered.forEach((row, i) => db.prepare('UPDATE queue_items SET sort = ? WHERE id = ?').run(i + 1, row.id));
  });
  tx();
}

/* ------------------------------------------------------------------ */
/* Playback state                                                      */
/* ------------------------------------------------------------------ */

export interface PlaybackState {
  currentItemId: string | null;
  isPlaying: boolean;
  /** Position in seconds at `stateAt`. */
  position: number;
  rate: number;
  stateAt: number;
  repeatMode: 'off' | 'one' | 'all';
  shuffle: boolean;
}

export function playbackState(room: RoomRow): PlaybackState {
  return {
    currentItemId: room.current_item_id,
    isPlaying: room.is_playing === 1,
    position: room.position,
    rate: room.rate,
    stateAt: room.state_at,
    repeatMode: room.repeat_mode,
    shuffle: room.shuffle === 1,
  };
}

/** Position the room *should* be at right now, extrapolated from the last update. */
export function projectedPosition(room: RoomRow, now = Date.now()): number {
  if (room.is_playing !== 1) return room.position;
  const elapsed = Math.max(0, now - room.state_at) / 1000;
  return room.position + elapsed * (room.rate || 1);
}

export function writePlayback(
  roomId: string,
  patch: Partial<{
    currentItemId: string | null;
    isPlaying: boolean;
    position: number;
    rate: number;
    repeatMode: string;
    shuffle: boolean;
  }>
): RoomRow {
  const room = roomById(roomId);
  if (!room) throw new Error('room gone');
  const now = Date.now();

  const next = {
    current_item_id: patch.currentItemId !== undefined ? patch.currentItemId : room.current_item_id,
    is_playing: patch.isPlaying !== undefined ? (patch.isPlaying ? 1 : 0) : room.is_playing,
    position: patch.position !== undefined ? Math.max(0, patch.position) : projectedPosition(room, now),
    rate: patch.rate !== undefined ? patch.rate : room.rate,
    repeat_mode: patch.repeatMode !== undefined ? patch.repeatMode : room.repeat_mode,
    shuffle: patch.shuffle !== undefined ? (patch.shuffle ? 1 : 0) : room.shuffle,
  };

  db.prepare(
    `UPDATE rooms SET current_item_id = ?, is_playing = ?, position = ?, rate = ?, repeat_mode = ?, shuffle = ?,
      state_at = ?, updated_at = ? WHERE id = ?`
  ).run(
    next.current_item_id,
    next.is_playing,
    next.position,
    next.rate,
    next.repeat_mode,
    next.shuffle,
    now,
    now,
    roomId
  );

  return roomById(roomId)!;
}

/** Returns the queue item that follows `currentId`, honouring repeat mode. */
export function nextItemId(roomId: string, currentId: string | null, repeat: string): string | null {
  const rows = queueRows(roomId);
  if (rows.length === 0) return null;
  if (repeat === 'one' && currentId) return currentId;
  const idx = currentId ? rows.findIndex((r) => r.id === currentId) : -1;
  if (idx === -1) return rows[0].id;
  if (idx + 1 < rows.length) return rows[idx + 1].id;
  return repeat === 'all' ? rows[0].id : null;
}

export function prevItemId(roomId: string, currentId: string | null): string | null {
  const rows = queueRows(roomId);
  if (rows.length === 0) return null;
  const idx = currentId ? rows.findIndex((r) => r.id === currentId) : -1;
  if (idx <= 0) return rows[0].id;
  return rows[idx - 1].id;
}

/* ------------------------------------------------------------------ */
/* Listings                                                            */
/* ------------------------------------------------------------------ */

export function roomSummaries(user: PublicUser, onlineCounts: Map<string, number>): RoomSummary[] {
  const rows = db
    .prepare(
      `SELECT r.*, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id AND m.banned = 0) AS member_count,
              (SELECT COUNT(*) FROM queue_items q WHERE q.room_id = r.id) AS queue_count,
              (SELECT role FROM room_members m2 WHERE m2.room_id = r.id AND m2.user_id = @uid AND m2.banned = 0) AS my_role,
              (SELECT title FROM queue_items q2 WHERE q2.id = r.current_item_id) AS now_playing,
              (SELECT thumbnail FROM queue_items q3 WHERE q3.id = r.current_item_id) AS thumb
       FROM rooms r
       LEFT JOIN users u ON u.id = r.owner_id
       WHERE r.is_public = 1
          OR r.owner_id = @uid
          OR EXISTS (SELECT 1 FROM room_members m3 WHERE m3.room_id = r.id AND m3.user_id = @uid AND m3.banned = 0)
          OR @isAdmin = 1
       ORDER BY r.updated_at DESC`
    )
    .all({ uid: user.id, isAdmin: user.isAdmin ? 1 : 0 }) as Array<
    RoomRow & {
      owner_name: string | null;
      member_count: number;
      queue_count: number;
      my_role: RoomRole | null;
      now_playing: string | null;
      thumb: string | null;
    }
  >;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    topic: r.topic,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    isPublic: r.is_public === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    memberCount: r.member_count,
    onlineCount: onlineCounts.get(r.id) ?? 0,
    queueCount: r.queue_count,
    nowPlaying: r.now_playing,
    thumbnail: r.thumb,
    myRole: r.my_role,
  }));
}

export function recentMessages(roomId: string, limit?: number) {
  const max = limit ?? Math.max(20, getSettingNumber('chat_history_limit') || 200);
  const rows = db
    .prepare(
      `SELECT m.id, m.user_id, m.kind, m.body, m.created_at, u.display_name, u.avatar_color
       FROM messages m LEFT JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ? ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(roomId, max) as Array<{
    id: string;
    user_id: string | null;
    kind: string;
    body: string;
    created_at: number;
    display_name: string | null;
    avatar_color: string | null;
  }>;

  return rows.reverse().map((r) => ({
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    body: r.body,
    createdAt: r.created_at,
    displayName: r.display_name,
    avatarColor: r.avatar_color,
  }));
}

export function memberList(roomId: string) {
  return db
    .prepare(
      `SELECT m.user_id, m.role, m.joined_at, m.last_seen_at, m.banned, u.display_name, u.username, u.avatar_color
       FROM room_members m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ? ORDER BY
         CASE m.role WHEN 'owner' THEN 0 WHEN 'host' THEN 1 ELSE 2 END, u.display_name COLLATE NOCASE`
    )
    .all(roomId) as Array<{
    user_id: string;
    role: RoomRole;
    joined_at: number;
    last_seen_at: number;
    banned: number;
    display_name: string;
    username: string;
    avatar_color: string;
  }>;
}
