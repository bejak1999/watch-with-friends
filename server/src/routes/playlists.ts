import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { newId, requireAuth } from '../auth';
import { addToQueue, canQueue, memberRole, queueDTO, roomById } from '../services/rooms';
import { broadcastQueue } from '../realtime';
import type { MediaItem } from '../types';

export const playlistsRouter = Router();
playlistsRouter.use(requireAuth);

const itemSchema = z.object({
  source: z.enum(['youtube', 'vimeo', 'twitch', 'twitch_live', 'ard', 'direct', 'upload']),
  sourceId: z.string().min(1).max(2000),
  url: z.string().max(2000).nullish(),
  title: z.string().min(1).max(300),
  author: z.string().max(200).nullish(),
  duration: z.number().nullish(),
  thumbnail: z.string().max(1000).nullish(),
});

function ownedPlaylist(id: string, userId: string, isAdmin: boolean) {
  const row = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as
    | { id: string; owner_id: string | null; name: string; is_shared: number }
    | undefined;
  if (!row) return { row: undefined, canEdit: false };
  return { row, canEdit: isAdmin || row.owner_id === userId };
}

function itemsOf(playlistId: string) {
  return db
    .prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY sort ASC')
    .all(playlistId) as Array<{
    id: string;
    sort: number;
    source: string;
    source_id: string;
    url: string | null;
    title: string;
    author: string | null;
    duration: number | null;
    thumbnail: string | null;
  }>;
}

function toDTO(rows: ReturnType<typeof itemsOf>) {
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    url: r.url,
    title: r.title,
    author: r.author,
    duration: r.duration,
    thumbnail: r.thumbnail,
  }));
}

playlistsRouter.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, u.display_name AS owner_name,
              (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS item_count,
              (SELECT thumbnail FROM playlist_items i2 WHERE i2.playlist_id = p.id ORDER BY i2.sort LIMIT 1) AS cover
       FROM playlists p LEFT JOIN users u ON u.id = p.owner_id
       WHERE p.owner_id = ? OR p.is_shared = 1
       ORDER BY p.updated_at DESC`
    )
    .all(req.user!.id) as Array<{
    id: string;
    owner_id: string | null;
    owner_name: string | null;
    name: string;
    description: string | null;
    is_shared: number;
    created_at: number;
    updated_at: number;
    item_count: number;
    cover: string | null;
  }>;

  res.json({
    playlists: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isShared: r.is_shared === 1,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      itemCount: r.item_count,
      cover: r.cover,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      mine: r.owner_id === req.user!.id,
    })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  isShared: z.boolean().optional(),
  items: z.array(itemSchema).max(1000).optional(),
  /** Convenience: snapshot a room's current queue into the new playlist. */
  fromRoomId: z.string().optional(),
});

playlistsRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Give the playlist a name' });
    return;
  }
  const id = newId();
  const now = Date.now();

  let items: MediaItem[] = (parsed.data.items || []) as MediaItem[];
  if (parsed.data.fromRoomId) {
    const room = roomById(parsed.data.fromRoomId);
    if (room && (memberRole(room.id, req.user!.id) || req.user!.isAdmin)) {
      items = queueDTO(room.id).map((q) => ({
        source: q.source as MediaItem['source'],
        sourceId: q.sourceId,
        url: q.url,
        title: q.title,
        author: q.author,
        duration: q.duration,
        thumbnail: q.thumbnail,
      }));
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO playlists (id, owner_id, name, description, is_shared, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.user!.id, parsed.data.name, parsed.data.description || null, parsed.data.isShared ? 1 : 0, now, now);
    items.forEach((item, i) => insertItem(id, item, i + 1));
  });
  tx();

  res.json({ id });
});

function insertItem(playlistId: string, item: MediaItem, sort: number) {
  db.prepare(
    `INSERT INTO playlist_items (id, playlist_id, sort, source, source_id, url, title, author, duration, thumbnail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId(),
    playlistId,
    sort,
    item.source,
    item.sourceId,
    item.url ?? null,
    item.title.slice(0, 300),
    item.author ?? null,
    item.duration ?? null,
    item.thumbnail ?? null
  );
}

playlistsRouter.get('/:id', (req, res) => {
  const { row } = ownedPlaylist(req.params.id, req.user!.id, req.user!.isAdmin);
  if (!row) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (row.owner_id !== req.user!.id && row.is_shared !== 1 && !req.user!.isAdmin) {
    res.status(403).json({ error: 'That playlist is private' });
    return;
  }
  const full = db.prepare('SELECT * FROM playlists WHERE id = ?').get(row.id) as any;
  res.json({
    playlist: {
      id: full.id,
      name: full.name,
      description: full.description,
      isShared: full.is_shared === 1,
      ownerId: full.owner_id,
      mine: full.owner_id === req.user!.id,
      createdAt: full.created_at,
      updatedAt: full.updated_at,
    },
    items: toDTO(itemsOf(row.id)),
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  isShared: z.boolean().optional(),
});

playlistsRouter.patch('/:id', (req, res) => {
  const { row, canEdit } = ownedPlaylist(req.params.id, req.user!.id, req.user!.isAdmin);
  if (!row) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (!canEdit) {
    res.status(403).json({ error: 'That is not your playlist' });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid change' });
    return;
  }
  const full = db.prepare('SELECT * FROM playlists WHERE id = ?').get(row.id) as any;
  db.prepare('UPDATE playlists SET name = ?, description = ?, is_shared = ?, updated_at = ? WHERE id = ?').run(
    parsed.data.name ?? full.name,
    parsed.data.description !== undefined ? parsed.data.description : full.description,
    parsed.data.isShared !== undefined ? (parsed.data.isShared ? 1 : 0) : full.is_shared,
    Date.now(),
    row.id
  );
  res.json({ ok: true });
});

playlistsRouter.post('/:id/items', (req, res) => {
  const { row, canEdit } = ownedPlaylist(req.params.id, req.user!.id, req.user!.isAdmin);
  if (!row) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (!canEdit) {
    res.status(403).json({ error: 'That is not your playlist' });
    return;
  }
  const parsed = z.object({ items: z.array(itemSchema).min(1).max(1000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nothing to add' });
    return;
  }
  const max = db.prepare('SELECT MAX(sort) AS m FROM playlist_items WHERE playlist_id = ?').get(row.id) as {
    m: number | null;
  };
  let sort = (max.m ?? 0) + 1;
  const tx = db.transaction(() => {
    for (const item of parsed.data.items) insertItem(row.id, item as MediaItem, sort++);
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), row.id);
  });
  tx();
  res.json({ ok: true, items: toDTO(itemsOf(row.id)) });
});

playlistsRouter.delete('/:id/items/:itemId', (req, res) => {
  const { row, canEdit } = ownedPlaylist(req.params.id, req.user!.id, req.user!.isAdmin);
  if (!row || !canEdit) {
    res.status(row ? 403 : 404).json({ error: row ? 'That is not your playlist' : 'Playlist not found' });
    return;
  }
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND id = ?').run(row.id, req.params.itemId);
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), row.id);
  res.json({ ok: true });
});

playlistsRouter.post('/:id/reorder', (req, res) => {
  const { row, canEdit } = ownedPlaylist(req.params.id, req.user!.id, req.user!.isAdmin);
  if (!row || !canEdit) {
    res.status(row ? 403 : 404).json({ error: row ? 'That is not your playlist' : 'Playlist not found' });
    return;
  }
  const parsed = z.object({ order: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid order' });
    return;
  }
  const tx = db.transaction(() => {
    parsed.data.order.forEach((itemId, i) => {
      db.prepare('UPDATE playlist_items SET sort = ? WHERE playlist_id = ? AND id = ?').run(i + 1, row.id, itemId);
    });
  });
  tx();
  res.json({ ok: true });
});

playlistsRouter.delete('/:id', (req, res) => {
  const { row, canEdit } = ownedPlaylist(req.params.id, req.user!.id, req.user!.isAdmin);
  if (!row) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (!canEdit) {
    res.status(403).json({ error: 'That is not your playlist' });
    return;
  }
  db.prepare('DELETE FROM playlists WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

/** Load an entire playlist into a room queue. */
playlistsRouter.post('/:id/load-into/:roomId', (req, res) => {
  const { row } = ownedPlaylist(req.params.id, req.user!.id, req.user!.isAdmin);
  if (!row) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }
  if (row.owner_id !== req.user!.id && row.is_shared !== 1 && !req.user!.isAdmin) {
    res.status(403).json({ error: 'That playlist is private' });
    return;
  }
  const room = roomById(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  const role = memberRole(room.id, req.user!.id);
  if (!canQueue(room, req.user!, role)) {
    res.status(403).json({ error: 'Only hosts can add to the queue in this room' });
    return;
  }
  const items = toDTO(itemsOf(row.id)).map((i) => ({
    source: i.source as MediaItem['source'],
    sourceId: i.sourceId,
    url: i.url,
    title: i.title,
    author: i.author,
    duration: i.duration,
    thumbnail: i.thumbnail,
  }));
  if (items.length === 0) {
    res.status(400).json({ error: 'That playlist is empty' });
    return;
  }
  addToQueue(room.id, req.user!.id, items);
  broadcastQueue(room.id, `${req.user!.displayName} loaded playlist "${row.name}" (${items.length} videos)`);
  res.json({ ok: true, added: items.length });
});
