import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { db } from '../db';
import { newId, requireAuth } from '../auth';
import {
  canManageRoom,
  joinRoom,
  memberList,
  memberRole,
  queueDTO,
  recentMessages,
  roomById,
  roomByInviteToken,
  roomSummaries,
} from '../services/rooms';
import { getOnlineCounts, roomSnapshot, broadcastRoom, kickUser, forgetRoom } from '../realtime';
import type { RoomRow } from '../types';

export const roomsRouter = Router();
roomsRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  topic: z.string().trim().max(200).optional(),
  isPublic: z.boolean().optional(),
  controlMode: z.enum(['everyone', 'hosts']).optional(),
  queueMode: z.enum(['everyone', 'hosts']).optional(),
});

roomsRouter.get('/', (req, res) => {
  res.json({ rooms: roomSummaries(req.user!, getOnlineCounts()) });
});

roomsRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Give the room a name (1-60 characters)' });
    return;
  }
  const id = newId(8);
  const now = Date.now();
  const token = crypto.randomBytes(9).toString('base64url');

  db.prepare(
    `INSERT INTO rooms (id, name, topic, owner_id, invite_token, is_public, control_mode, queue_mode, created_at, updated_at, state_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    parsed.data.name,
    parsed.data.topic || null,
    req.user!.id,
    token,
    parsed.data.isPublic ? 1 : 0,
    parsed.data.controlMode || 'everyone',
    parsed.data.queueMode || 'everyone',
    now,
    now,
    now
  );
  joinRoom(id, req.user!.id, 'owner');
  res.json({ room: roomSnapshot(id, req.user!) });
});

/** Resolve an invite token to a room id without joining. */
roomsRouter.get('/invite/:token', (req, res) => {
  const room = roomByInviteToken(req.params.token) as RoomRow | undefined;
  if (!room) {
    res.status(404).json({ error: 'That invite link is not valid any more' });
    return;
  }
  const owner = room.owner_id
    ? (db.prepare('SELECT display_name FROM users WHERE id = ?').get(room.owner_id) as { display_name: string } | undefined)
    : undefined;
  res.json({
    room: { id: room.id, name: room.name, topic: room.topic, ownerName: owner?.display_name ?? null },
  });
});

roomsRouter.post('/invite/:token/accept', (req, res) => {
  const room = roomByInviteToken(req.params.token);
  if (!room) {
    res.status(404).json({ error: 'That invite link is not valid any more' });
    return;
  }
  const role = joinRoom(room.id, req.user!.id);
  if (!role) {
    res.status(403).json({ error: 'You have been removed from this room' });
    return;
  }
  res.json({ roomId: room.id });
});

roomsRouter.get('/:id', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  const role = memberRole(room.id, req.user!.id);
  if (!role && room.is_public !== 1 && !req.user!.isAdmin) {
    res.status(403).json({ error: 'This room is invite-only' });
    return;
  }
  if (!role) joinRoom(room.id, req.user!.id);
  res.json({
    room: roomSnapshot(room.id, req.user!),
    queue: queueDTO(room.id),
    messages: recentMessages(room.id),
    members: memberList(room.id),
  });
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  topic: z.string().trim().max(200).nullable().optional(),
  isPublic: z.boolean().optional(),
  controlMode: z.enum(['everyone', 'hosts']).optional(),
  queueMode: z.enum(['everyone', 'hosts']).optional(),
  waitForBuffer: z.boolean().optional(),
});

roomsRouter.patch('/:id', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  const role = memberRole(room.id, req.user!.id);
  if (!canManageRoom(room, req.user!, role)) {
    res.status(403).json({ error: 'Only the room owner can change these settings' });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid room settings' });
    return;
  }
  const d = parsed.data;
  db.prepare(
    `UPDATE rooms SET name = ?, topic = ?, is_public = ?, control_mode = ?, queue_mode = ?, wait_for_buffer = ?,
      updated_at = ? WHERE id = ?`
  ).run(
    d.name ?? room.name,
    d.topic !== undefined ? d.topic : room.topic,
    d.isPublic !== undefined ? (d.isPublic ? 1 : 0) : room.is_public,
    d.controlMode ?? room.control_mode,
    d.queueMode ?? room.queue_mode,
    d.waitForBuffer !== undefined ? (d.waitForBuffer ? 1 : 0) : room.wait_for_buffer,
    Date.now(),
    room.id
  );
  broadcastRoom(room.id);
  res.json({ room: roomSnapshot(room.id, req.user!) });
});

roomsRouter.post('/:id/reset-invite', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  if (!canManageRoom(room, req.user!, memberRole(room.id, req.user!.id))) {
    res.status(403).json({ error: 'Only the room owner can do that' });
    return;
  }
  const token = crypto.randomBytes(9).toString('base64url');
  db.prepare('UPDATE rooms SET invite_token = ? WHERE id = ?').run(token, room.id);
  res.json({ inviteToken: token });
});

const roleSchema = z.object({ role: z.enum(['host', 'member']) });

roomsRouter.post('/:id/members/:userId/role', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  if (!canManageRoom(room, req.user!, memberRole(room.id, req.user!.id))) {
    res.status(403).json({ error: 'Only the room owner can change roles' });
    return;
  }
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  if (req.params.userId === room.owner_id) {
    res.status(400).json({ error: 'The owner role cannot be changed' });
    return;
  }
  db.prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?').run(
    parsed.data.role,
    room.id,
    req.params.userId
  );
  broadcastRoom(room.id);
  res.json({ ok: true });
});

roomsRouter.post('/:id/members/:userId/kick', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  if (!canManageRoom(room, req.user!, memberRole(room.id, req.user!.id))) {
    res.status(403).json({ error: 'Only the room owner can remove people' });
    return;
  }
  if (req.params.userId === room.owner_id) {
    res.status(400).json({ error: 'You cannot remove the room owner' });
    return;
  }
  const ban = Boolean((req.body as { ban?: boolean })?.ban);
  if (ban) {
    db.prepare('UPDATE room_members SET banned = 1, role = ? WHERE room_id = ? AND user_id = ?').run(
      'member',
      room.id,
      req.params.userId
    );
  } else {
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(room.id, req.params.userId);
  }
  kickUser(room.id, req.params.userId, ban ? 'You were banned from this room' : 'You were removed from this room');
  broadcastRoom(room.id);
  res.json({ ok: true });
});

roomsRouter.post('/:id/members/:userId/unban', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  if (!canManageRoom(room, req.user!, memberRole(room.id, req.user!.id))) {
    res.status(403).json({ error: 'Only the room owner can do that' });
    return;
  }
  db.prepare('UPDATE room_members SET banned = 0 WHERE room_id = ? AND user_id = ?').run(room.id, req.params.userId);
  broadcastRoom(room.id);
  res.json({ ok: true });
});

/** Leave a room you are a member of. Owners must delete instead. */
roomsRouter.post('/:id/leave', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  if (room.owner_id === req.user!.id) {
    res.status(400).json({ error: 'You own this room - delete it instead' });
    return;
  }
  db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(room.id, req.user!.id);
  broadcastRoom(room.id);
  res.json({ ok: true });
});

roomsRouter.delete('/:id', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  if (!canManageRoom(room, req.user!, memberRole(room.id, req.user!.id))) {
    res.status(403).json({ error: 'Only the room owner can delete this room' });
    return;
  }
  kickUser(room.id, null, 'This room was deleted');
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  forgetRoom(room.id);
  res.json({ ok: true });
});
