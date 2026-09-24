import type { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { db, getSettingNumber } from './db';
import { SESSION_COOKIE, avatarUrlFor, newId, userFromToken } from './auth';
import {
  addToQueue,
  canControl,
  canManageRoom,
  canQueue,
  clearQueue,
  currentMedia,
  memberList,
  memberRole,
  moveQueueItem,
  nextEpisodeId,
  nextItemId,
  playbackState,
  prevEpisodeId,
  prevItemId,
  projectedPosition,
  queueDTO,
  queueRows,
  recentMessages,
  removeQueueItem,
  roomById,
  shuffleQueue,
  writePlayback,
} from './services/rooms';
import { z } from 'zod';
import { creditWatchTime, logPlay } from './services/stats';
import { createLogger } from './services/logger';
import { recordProgress, resetProgress, setRoomPlaylist } from './services/playlistProgress';
import type { MediaItem, PublicUser, RoomRole, RoomRow } from './types';

const log = createLogger('sync');

/**
 * Socket payloads arrive straight from a browser, so they get the same
 * validation as the REST body. Without this a member could stuff arbitrary
 * strings into the queue that every other viewer then renders and loads.
 */
const queueItemSchema = z.object({
  source: z.enum(['youtube', 'vimeo', 'twitch', 'twitch_live', 'ard', 'zdf', 'arte', 'srg', 'dailymotion', 'peertube', 'archive', 'mediathek', 'direct', 'upload']),
  sourceId: z.string().min(1).max(2000),
  url: z
    .string()
    .max(2000)
    .refine(
      (v) => !v || /^https?:\/\//i.test(v) || v.startsWith('/api/uploads/'),
      'only http(s) links or uploads on this server can be queued'
    )
    .nullish(),
  title: z.string().min(1).max(300),
  author: z.string().max(200).nullish(),
  duration: z.number().finite().min(0).max(86400 * 7).nullish(),
  thumbnail: z
    .string()
    .max(1000)
    .refine((v) => !v || /^https?:\/\//i.test(v), 'thumbnails must be http(s)')
    .nullish(),
});

const queueAddSchema = z.object({
  items: z.array(queueItemSchema).min(1).max(500),
  atTop: z.boolean().optional(),
  silent: z.boolean().optional(),
});

/** Cheap per-socket flood control for the chatty events. */
class Bucket {
  private hits: number[] = [];
  constructor(
    private limit: number,
    private windowMs: number
  ) {}
  allow(): boolean {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

let io: Server | null = null;

interface SocketState {
  user: PublicUser;
  roomId: string | null;
  buffering: boolean;
  reportedPosition: number;
  reportedAt: number;
  chatBucket: Bucket;
  queueBucket: Bucket;
}

const socketState = new WeakMap<Socket, SocketState>();
/** roomId -> whether the server auto-paused while waiting for a buffering viewer. */
const autoPaused = new Map<string, boolean>();
/** roomId -> when the wait began, so one stuck viewer cannot hold it forever. */
const waitingSince = new Map<string, number>();
/** roomId -> timestamp of the last track change, used to swallow duplicate "ended". */
const lastAdvance = new Map<string, number>();
/** roomId -> pending "everyone left" freeze, cancelled if anybody comes back. */
const emptyRoomTimers = new Map<string, NodeJS.Timeout>();
/**
 * roomId -> the queue ran out. The room keeps the last video selected, paused
 * at its end, which used to look exactly like "something is still playing" -
 * so a video added afterwards sat there until somebody found the play button.
 */
const queueEnded = new Map<string, boolean>();

/**
 * A page reload, a phone locking its screen or a few seconds of bad signal all
 * look exactly like the last viewer leaving. Freezing the room instantly meant
 * coming back to a paused video that only a manual play would revive, so wait a
 * little and let a reconnect cancel it.
 */
const EMPTY_ROOM_GRACE_MS = 45_000;
/** Heartbeat period, and therefore the granularity of watch-time accrual. */
const TICK_SECONDS = 5;
/**
 * Longest the room will hold for a buffering viewer. Past this their player
 * is presumed broken rather than slow, and everyone else stops being punished
 * for it.
 */
const MAX_WAIT_MS = 25_000;

function cancelEmptyRoomFreeze(roomId: string): void {
  const timer = emptyRoomTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    emptyRoomTimers.delete(roomId);
  }
}

function scheduleEmptyRoomFreeze(roomId: string): void {
  cancelEmptyRoomFreeze(roomId);
  const timer = setTimeout(() => {
    emptyRoomTimers.delete(roomId);
    // Somebody may have rejoined while we waited.
    if (onlineUserIds(roomId).size > 0) return;
    const room = roomById(roomId);
    if (room?.is_playing === 1) {
      writePlayback(roomId, { isPlaying: false });
      emitPlayback(roomId);
      // Worth a line: "it was paused when I came back" and "it stopped on its
      // own" look identical from the outside, and this is one of the few
      // things that pauses a room without anybody pressing anything.
      log.info('froze an abandoned room', {
        room: roomId,
        afterMs: EMPTY_ROOM_GRACE_MS,
        position: room.position,
      });
    }
  }, EMPTY_ROOM_GRACE_MS);
  timer.unref?.();
  emptyRoomTimers.set(roomId, timer);
}

/** Frees per-room bookkeeping when a room goes away. */
export function forgetRoom(roomId: string): void {
  cancelEmptyRoomFreeze(roomId);
  autoPaused.delete(roomId);
  waitingSince.delete(roomId);
  lastAdvance.delete(roomId);
  queueEnded.delete(roomId);
}

/* ------------------------------------------------------------------ */
/* Presence helpers                                                    */
/* ------------------------------------------------------------------ */

function socketsIn(roomId: string): Socket[] {
  if (!io) return [];
  const room = io.sockets.adapter.rooms.get(`room:${roomId}`);
  if (!room) return [];
  const out: Socket[] = [];
  for (const id of room) {
    const s = io.sockets.sockets.get(id);
    if (s) out.push(s);
  }
  return out;
}

export function getOnlineCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  if (!io) return counts;
  for (const [key, set] of io.sockets.adapter.rooms) {
    if (!key.startsWith('room:')) continue;
    const roomId = key.slice(5);
    const users = new Set<string>();
    for (const id of set) {
      const s = io.sockets.sockets.get(id);
      const st = s && socketState.get(s);
      if (st) users.add(st.user.id);
    }
    counts.set(roomId, users.size);
  }
  return counts;
}

function onlineUserIds(roomId: string): Set<string> {
  const ids = new Set<string>();
  for (const s of socketsIn(roomId)) {
    const st = socketState.get(s);
    if (st) ids.add(st.user.id);
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

export function roomSnapshot(roomId: string, user: PublicUser) {
  const room = roomById(roomId);
  if (!room) return null;
  const role = memberRole(roomId, user.id);
  const owner = room.owner_id
    ? (db.prepare('SELECT display_name FROM users WHERE id = ?').get(room.owner_id) as
        | { display_name: string }
        | undefined)
    : undefined;

  return {
    id: room.id,
    name: room.name,
    topic: room.topic,
    ownerId: room.owner_id,
    ownerName: owner?.display_name ?? null,
    inviteToken: room.invite_token,
    isPublic: room.is_public === 1,
    controlMode: room.control_mode,
    queueMode: room.queue_mode,
    waitForBuffer: room.wait_for_buffer === 1,
    /** Playlist this queue came from, so the room can say what it is watching. */
    playlistId: room.playlist_id,
    /**
     * Whether the room is currently holding for somebody. The banner used to be
     * driven only by the sync:waiting event, so a client that missed the "all
     * clear" - a reconnect is enough - showed "Waiting for everyone" forever
     * over a room that was playing perfectly well. Carry the truth in the
     * snapshot so every join corrects itself.
     */
    waiting: autoPaused.get(roomId) === true,
    createdAt: room.created_at,
    myRole: role,
    permissions: {
      canControl: canControl(room, user, role),
      canQueue: canQueue(room, user, role),
      canManage: canManageRoom(room, user, role),
    },
    playback: playbackPayload(roomId)!,
  };
}

/**
 * Clients extrapolate from `position` at `stateAt`, so both must describe the same
 * instant. Sending a projected position with the original timestamp would make every
 * client count the elapsed time twice and creep forward on each heartbeat.
 */
function playbackPayload(roomId: string) {
  const room = roomById(roomId);
  if (!room) return null;
  return { ...playbackState(room), serverNow: Date.now() };
}

function membersPayload(roomId: string) {
  const online = onlineUserIds(roomId);
  const buffering = new Set<string>();
  const positions = new Map<string, number>();
  for (const s of socketsIn(roomId)) {
    const st = socketState.get(s);
    if (!st) continue;
    if (st.buffering) buffering.add(st.user.id);
    positions.set(st.user.id, st.reportedPosition);
  }
  return memberList(roomId).map((m) => ({
    userId: m.user_id,
    username: m.username,
    displayName: m.display_name,
    avatarColor: m.avatar_color,
    avatarUrl: avatarUrlFor(m.user_id, m.avatar_updated_at),
    role: m.role,
    banned: m.banned === 1,
    online: online.has(m.user_id),
    buffering: buffering.has(m.user_id),
    position: positions.get(m.user_id) ?? null,
  }));
}

function emitPlayback(roomId: string) {
  const payload = playbackPayload(roomId);
  if (!payload || !io) return;
  io.to(`room:${roomId}`).emit('player:state', payload);
}

function emitMembers(roomId: string) {
  if (!io) return;
  io.to(`room:${roomId}`).emit('members:state', { members: membersPayload(roomId) });
}

export function broadcastQueue(roomId: string, systemMessage?: string) {
  if (!io) return;
  io.to(`room:${roomId}`).emit('queue:state', { queue: queueDTO(roomId) });
  if (systemMessage) systemMessageTo(roomId, systemMessage);
}

/** Pushes a fresh per-user snapshot (permissions differ per viewer). */
export function broadcastRoom(roomId: string) {
  if (!io) return;
  for (const s of socketsIn(roomId)) {
    const st = socketState.get(s);
    if (!st) continue;
    const snap = roomSnapshot(roomId, st.user);
    if (snap) s.emit('room:updated', { room: snap });
  }
  emitMembers(roomId);
}

export function kickUser(roomId: string, userId: string | null, reason: string) {
  for (const s of socketsIn(roomId)) {
    const st = socketState.get(s);
    if (!st) continue;
    if (userId === null || st.user.id === userId) {
      s.emit('room:kicked', { reason });
      s.leave(`room:${roomId}`);
      st.roomId = null;
    }
  }
}

/** A line in the room's chat from the app itself, for callers outside the socket layer. */
export function broadcastSystemMessage(roomId: string, body: string): void {
  systemMessageTo(roomId, body);
}

function systemMessageTo(roomId: string, body: string) {
  const id = newId();
  const now = Date.now();
  db.prepare('INSERT INTO messages (id, room_id, user_id, kind, body, created_at) VALUES (?, ?, NULL, ?, ?, ?)').run(
    id,
    roomId,
    'system',
    body,
    now
  );
  trimHistory(roomId);
  io?.to(`room:${roomId}`).emit('chat:message', {
    message: { id, userId: null, kind: 'system', body, createdAt: now, displayName: null, avatarColor: null },
  });
}

function trimHistory(roomId: string) {
  const limit = Math.max(50, getSettingNumber('chat_history_limit') || 300);
  db.prepare(
    `DELETE FROM messages WHERE room_id = ? AND id NOT IN
      (SELECT id FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?)`
  ).run(roomId, roomId, limit);
}

/* ------------------------------------------------------------------ */
/* Playback transitions                                                */
/* ------------------------------------------------------------------ */

function markPlayed(itemId: string | null) {
  if (!itemId) return;
  db.prepare('UPDATE queue_items SET played_at = ? WHERE id = ? AND played_at IS NULL').run(Date.now(), itemId);
}

/**
 * Is the room free to start something new without interrupting anybody? Yes
 * when nothing is selected, when the queue has run out, or when the selected
 * video sits finished at its end (which survives a restart, unlike the flag).
 * A video paused halfway is not idle - somebody paused it on purpose.
 */
export function roomIsIdle(roomId: string): boolean {
  const room = roomById(roomId);
  if (!room) return false;
  if (!room.current_item_id) return true;
  if (room.is_playing === 1) return false;
  if (queueEnded.get(roomId)) return true;
  const item = currentMedia(room);
  return Boolean(item?.duration && item.duration > 0 && room.position >= item.duration - 2);
}

/**
 * Select what plays. `playlistId` says which list `itemId` belongs to: null for
 * the queue, or a saved playlist whose episode it is. Picking from one list
 * leaves the other exactly as it was - the two are not connected.
 */
function selectItem(roomId: string, itemId: string | null, autoplay: boolean, playlistId: string | null = null) {
  queueEnded.delete(roomId);
  setRoomPlaylist(roomId, itemId ? playlistId : null);
  const room = writePlayback(roomId, { currentItemId: itemId, position: 0, isPlaying: autoplay && Boolean(itemId) });
  const media = currentMedia(room);
  if (media) logPlay(roomId, media.title, media.source, media.addedBy);
  if (!playlistId) markPlayed(itemId);
  lastAdvance.set(roomId, Date.now());
  endWait(roomId);
  emitPlayback(roomId);
  broadcastQueue(roomId);
}

/**
 * Play an episode of a saved playlist, optionally from a given offset ("continue
 * where we left off" lands mid-episode). The queue is left alone.
 */
export function playEpisode(roomId: string, playlistId: string, itemId: string, position: number, autoplay = true): void {
  selectItem(roomId, itemId, autoplay, playlistId);
  if (position > 0) {
    writePlayback(roomId, { position, isPlaying: autoplay });
    emitPlayback(roomId);
  }
}

/** Rooms currently playing from `playlistId`, optionally only those on one episode. */
function roomsPlaying(playlistId: string, itemId?: string): RoomRow[] {
  return (
    itemId
      ? db.prepare('SELECT * FROM rooms WHERE playlist_id = ? AND current_item_id = ?').all(playlistId, itemId)
      : db.prepare('SELECT * FROM rooms WHERE playlist_id = ?').all(playlistId)
  ) as RoomRow[];
}

/** Every open Lists tab refetches, so an edit shows up for everyone at once. */
export function announcePlaylistChange(playlistId: string): void {
  io?.emit('playlist:changed', { playlistId });
}

/**
 * Remove an episode. A room watching exactly that one moves on to the next
 * (still playing if it was), rather than being left on a video that is gone.
 */
export function removeEpisode(playlistId: string, itemId: string, remove: () => void): void {
  const affected = roomsPlaying(playlistId, itemId).map((room) => ({
    room,
    next: nextEpisodeId(playlistId, itemId, 'off'),
  }));
  remove();
  for (const { room, next } of affected) {
    selectItem(room.id, next, next ? room.is_playing === 1 : false, next ? playlistId : null);
  }
  announcePlaylistChange(playlistId);
}

/** A playlist is being deleted: rooms playing it stop, their queue untouched. */
export function playlistDeleted(playlistId: string): void {
  for (const room of roomsPlaying(playlistId)) {
    selectItem(room.id, null, false);
    systemMessageTo(room.id, 'The playlist that was playing has been deleted');
  }
  announcePlaylistChange(playlistId);
}

/** Past the end by this much with nobody watching, the room moves on by itself. */
const OVERRUN_S = 4;

/**
 * The next video used to start only when a player reported "ended". With no
 * player able to - a tab still waiting for "Join playback", a throttled
 * background tab, a player that never fires the event - the room sat past the
 * end of its video forever. The server knows the duration, so it moves on.
 *
 * It only steps in when no viewer is following along: somebody in sync is
 * trusted to report the end themselves, which also means a stored duration
 * that is too short can never cut a video off while people watch it.
 */
function overranTheEnd(
  roomId: string,
  room: RoomRow,
  payload: { position: number; stateAt: number; rate: number }
): boolean {
  if (!room.current_item_id) return false;
  const item = currentMedia(room);
  if (!item?.duration || item.duration <= 0 || item.source === 'twitch_live') return false;
  const at = payload.position + ((Date.now() - payload.stateAt) / 1000) * (payload.rate || 1);
  if (at < item.duration + OVERRUN_S) return false;
  if (Date.now() - (lastAdvance.get(roomId) ?? 0) < 5000) return false;

  const following = socketsIn(roomId).some((s) => {
    const st = socketState.get(s);
    return Boolean(st && Date.now() - st.reportedAt < 6000 && Math.abs(st.reportedPosition - at) < 10);
  });
  if (following) return false;

  log.info('moved on - nobody reported the end of the video', {
    room: roomId,
    at: Math.round(at),
    duration: Math.round(item.duration),
  });
  return true;
}

function advance(roomId: string, direction: 1 | -1 = 1) {
  const room = roomById(roomId);
  if (!room) return;
  // Each list only ever steps through itself: the end of a playlist does not
  // spill into the queue, nor the other way round.
  const playlistId = room.playlist_id ?? null;
  const target = playlistId
    ? direction === 1
      ? nextEpisodeId(playlistId, room.current_item_id, room.repeat_mode)
      : prevEpisodeId(playlistId, room.current_item_id)
    : direction === 1
      ? nextItemId(roomId, room.current_item_id, room.repeat_mode)
      : prevItemId(roomId, room.current_item_id);

  if (!target) {
    writePlayback(roomId, { isPlaying: false });
    queueEnded.set(roomId, true);
    emitPlayback(roomId);
    if (playlistId) {
      // Watched to the end: next time it starts from the first episode again
      // instead of offering to "continue" the last few seconds of the finale.
      resetProgress(playlistId);
      const name = db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlistId) as
        | { name: string }
        | undefined;
      systemMessageTo(roomId, `Reached the end of the playlist${name ? ` "${name.name}"` : ''}`);
    } else {
      systemMessageTo(roomId, 'Reached the end of the queue');
    }
    return;
  }
  if (target === room.current_item_id && room.repeat_mode === 'one') {
    writePlayback(roomId, { position: 0, isPlaying: true });
    lastAdvance.set(roomId, Date.now());
    emitPlayback(roomId);
    return;
  }
  selectItem(roomId, target, true, playlistId);
}

/** Pause/resume automatically while someone is still buffering. */
function reconcileBuffering(roomId: string) {
  const room = roomById(roomId);
  if (!room) return;

  const wasAutoPaused = autoPaused.get(roomId) === true;

  // The setting can be turned off mid-wait; do not strand the room paused.
  if (room.wait_for_buffer !== 1) {
    if (wasAutoPaused) resumeAfterWait(roomId);
    return;
  }

  const buffering = socketsIn(roomId).filter((s) => socketState.get(s)?.buffering);
  const anyBuffering = buffering.length > 0;

  if (anyBuffering && room.is_playing === 1) {
    writePlayback(roomId, { isPlaying: false });
    autoPaused.set(roomId, true);
    waitingSince.set(roomId, Date.now());
    emitPlayback(roomId);
    io?.to(`room:${roomId}`).emit('sync:waiting', { waiting: true });
    log.info('waiting for buffer', {
      room: roomId,
      on: buffering.map((s) => socketState.get(s)?.user.username),
    });
    return;
  }

  if (!anyBuffering && wasAutoPaused) resumeAfterWait(roomId);
}

/**
 * Every way out of a wait has to say so. The banner is driven by sync:waiting,
 * and only resumeAfterWait used to send the all-clear - so a host pressing
 * play, pause or skipping during a wait left "Waiting for everyone" on every
 * screen while the room played on perfectly in sync.
 */
function endWait(roomId: string): void {
  const was = autoPaused.get(roomId) === true;
  autoPaused.set(roomId, false);
  waitingSince.delete(roomId);
  if (was) io?.to(`room:${roomId}`).emit('sync:waiting', { waiting: false });
}

function resumeAfterWait(roomId: string) {
  const waited = waitingSince.get(roomId);
  autoPaused.set(roomId, false);
  waitingSince.delete(roomId);
  writePlayback(roomId, { isPlaying: true });
  emitPlayback(roomId);
  io?.to(`room:${roomId}`).emit('sync:waiting', { waiting: false });
  log.info('everyone caught up', { room: roomId, waitedMs: waited ? Date.now() - waited : 0 });
}

/**
 * Safety net for a viewer whose player never recovers - a crashed tab, a dead
 * stream, a bug in our own stall detection. Without this the room could sit
 * paused indefinitely with no way out but a manual play.
 */
function giveUpOnStuckViewers(roomId: string) {
  if (autoPaused.get(roomId) !== true) return;
  const since = waitingSince.get(roomId);
  if (!since || Date.now() - since < MAX_WAIT_MS) return;

  const stuck: string[] = [];
  for (const s of socketsIn(roomId)) {
    const st = socketState.get(s);
    if (st?.buffering) {
      st.buffering = false;
      stuck.push(st.user.displayName);
    }
  }
  if (stuck.length > 0) {
    systemMessageTo(
      roomId,
      `Carried on without ${stuck.join(', ')} - still buffering after ${Math.round(MAX_WAIT_MS / 1000)}s`
    );
    log.warn('gave up on stuck viewers', { room: roomId, stuck, afterMs: Date.now() - since });
  }
  resumeAfterWait(roomId);
  emitMembers(roomId);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function initRealtime(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    path: '/socket.io',
    // Cloudflare tunnels handle websockets fine, but polling is a safe fallback.
    transports: ['websocket', 'polling'],
    /**
     * Switching a 4K stream can block the browser's main thread long enough to
     * miss a heartbeat, and the old 25s timeout dropped the socket for it - the
     * user saw "reconnecting" and lost the controls for ~20s. Be patient
     * instead; a genuinely dead client is still gone well inside the 45s
     * empty-room grace.
     */
    pingInterval: 20000,
    pingTimeout: 40000,
    maxHttpBufferSize: 1e6,
  });

  io.engine.on('connection_error', (err: { code: number; message: string; context?: unknown }) => {
    log.warn('socket refused', { code: err.code, message: err.message });
  });

  io.use((socket, next) => {
    const parsed = parseCookies(socket.handshake.headers.cookie);
    const user = userFromToken(parsed[SESSION_COOKIE]);
    if (!user) {
      next(new Error('unauthorised'));
      return;
    }
    socketState.set(socket, {
      user,
      roomId: null,
      buffering: false,
      reportedPosition: 0,
      reportedAt: 0,
      chatBucket: new Bucket(8, 5000),
      queueBucket: new Bucket(12, 10000),
    });
    next();
  });

  io.on('connection', (socket) => {
    const state = socketState.get(socket)!;

    const ack = (cb: unknown, payload: unknown) => {
      if (typeof cb === 'function') (cb as (p: unknown) => void)(payload);
    };

    const currentRoom = () => (state.roomId ? roomById(state.roomId) : undefined);

    const guard = (need: 'control' | 'queue' | 'manage'): boolean => {
      const room = currentRoom();
      if (!room) return false;
      const role: RoomRole | null = memberRole(room.id, state.user.id);
      const ok =
        need === 'control'
          ? canControl(room, state.user, role)
          : need === 'queue'
            ? canQueue(room, state.user, role)
            : canManageRoom(room, state.user, role);
      if (!ok) socket.emit('toast', { type: 'error', message: 'Only hosts can do that in this room' });
      return ok;
    };

    socket.on('time:sync', (clientSent: number, cb: unknown) => {
      ack(cb, { clientSent, serverNow: Date.now() });
    });

    socket.on('room:join', (payload: { roomId?: string }, cb: unknown) => {
      const roomId = String(payload?.roomId || '');
      const room = roomById(roomId);
      if (!room) {
        ack(cb, { error: 'Room not found' });
        return;
      }
      let role = memberRole(roomId, state.user.id);
      if (!role) {
        if (room.is_public !== 1 && !state.user.isAdmin) {
          ack(cb, { error: 'This room is invite-only' });
          return;
        }
        db.prepare(
          `INSERT INTO room_members (room_id, user_id, role, joined_at, last_seen_at) VALUES (?, ?, 'member', ?, ?)
           ON CONFLICT(room_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
        ).run(roomId, state.user.id, Date.now(), Date.now());
        role = 'member';
      }

      if (state.roomId && state.roomId !== roomId) {
        socket.leave(`room:${state.roomId}`);
        emitMembers(state.roomId);
      }
      const wasOnlineElsewhere = onlineUserIds(roomId).has(state.user.id);
      state.roomId = roomId;
      state.buffering = false;
      socket.join(`room:${roomId}`);
      // Somebody is watching again, so the room is not abandoned after all.
      cancelEmptyRoomFreeze(roomId);
      db.prepare('UPDATE room_members SET last_seen_at = ? WHERE room_id = ? AND user_id = ?').run(
        Date.now(),
        roomId,
        state.user.id
      );

      ack(cb, {
        room: roomSnapshot(roomId, state.user),
        queue: queueDTO(roomId),
        messages: recentMessages(roomId),
        members: membersPayload(roomId),
      });
      emitMembers(roomId);
      if (!wasOnlineElsewhere) systemMessageTo(roomId, `${state.user.displayName} joined`);
      log.info('joined room', { room: roomId, user: state.user.username, role, online: onlineUserIds(roomId).size });
    });

    socket.on('room:leave', () => {
      if (!state.roomId) return;
      const roomId = state.roomId;
      socket.leave(`room:${roomId}`);
      state.roomId = null;
      emitMembers(roomId);
      reconcileBuffering(roomId);
      if (!onlineUserIds(roomId).has(state.user.id)) systemMessageTo(roomId, `${state.user.displayName} left`);
      if (onlineUserIds(roomId).size === 0) scheduleEmptyRoomFreeze(roomId);
    });

    /* ---------------- playback ---------------- */

    socket.on('player:play', (payload: { position?: number }) => {
      if (!guard('control')) return;
      const room = currentRoom()!;
      if (!room.current_item_id) {
        const first = queueRows(room.id)[0];
        if (!first) return;
        selectItem(room.id, first.id, true);
        return;
      }
      const pos = typeof payload?.position === 'number' ? payload.position : projectedPosition(room);
      writePlayback(room.id, { isPlaying: true, position: pos });
      endWait(room.id);
      emitPlayback(room.id);
    });

    socket.on('player:pause', (payload: { position?: number }) => {
      if (!guard('control')) return;
      const room = currentRoom()!;
      const pos = typeof payload?.position === 'number' ? payload.position : projectedPosition(room);
      writePlayback(room.id, { isPlaying: false, position: pos });
      endWait(room.id);
      emitPlayback(room.id);
    });

    socket.on('player:seek', (payload: { position?: number; play?: boolean }) => {
      if (!guard('control')) return;
      const room = currentRoom()!;
      const pos = Math.max(0, Number(payload?.position) || 0);
      const playing = payload?.play ?? room.is_playing === 1;
      writePlayback(room.id, { position: pos, isPlaying: playing });
      // Seeking into playback overrides a wait exactly like pressing play. A
      // seek that leaves the room paused lets the wait carry on.
      if (playing) endWait(room.id);
      emitPlayback(room.id);
    });

    socket.on('player:rate', (payload: { rate?: number }) => {
      if (!guard('control')) return;
      const room = currentRoom()!;
      const rate = Math.min(3, Math.max(0.25, Number(payload?.rate) || 1));
      writePlayback(room.id, { rate });
      emitPlayback(room.id);
    });

    socket.on('player:select', (payload: { itemId?: string; autoplay?: boolean }) => {
      if (!guard('control')) return;
      const room = currentRoom()!;
      const itemId = String(payload?.itemId || '');
      const exists = db.prepare('SELECT id FROM queue_items WHERE id = ? AND room_id = ?').get(itemId, room.id);
      if (!exists) return;
      selectItem(room.id, itemId, payload?.autoplay !== false);
    });

    socket.on('player:next', () => {
      if (!guard('control')) return;
      advance(currentRoom()!.id, 1);
    });

    socket.on('player:prev', () => {
      if (!guard('control')) return;
      advance(currentRoom()!.id, -1);
    });

    socket.on('player:repeat', (payload: { mode?: string }) => {
      if (!guard('control')) return;
      const room = currentRoom()!;
      const mode = ['off', 'one', 'all'].includes(String(payload?.mode)) ? String(payload!.mode) : 'off';
      writePlayback(room.id, { repeatMode: mode });
      emitPlayback(room.id);
    });

    /** Any viewer may report the end of a track; duplicates are ignored. */
    socket.on('player:ended', (payload: { itemId?: string }) => {
      const room = currentRoom();
      if (!room || !room.current_item_id) return;
      if (payload?.itemId && payload.itemId !== room.current_item_id) return;
      const since = Date.now() - (lastAdvance.get(room.id) ?? 0);
      if (since < 2000) return;
      advance(room.id, 1);
    });

    /** Fill in durations the server could not learn up front (uploads, direct URLs). */
    socket.on('media:duration', (payload: { itemId?: string; duration?: number }) => {
      const room = currentRoom();
      const duration = Number(payload?.duration);
      if (!room || !payload?.itemId || !Number.isFinite(duration) || duration <= 0) return;
      if (room.playlist_id) {
        const changed = db
          .prepare(
            'UPDATE playlist_items SET duration = ? WHERE id = ? AND playlist_id = ? AND (duration IS NULL OR duration = 0)'
          )
          .run(Math.round(duration), payload.itemId, room.playlist_id);
        if (changed.changes > 0) emitPlayback(room.id);
        return;
      }
      const changed = db
        .prepare('UPDATE queue_items SET duration = ? WHERE id = ? AND room_id = ? AND (duration IS NULL OR duration = 0)')
        .run(Math.round(duration), payload.itemId, room.id);
      if (changed.changes > 0) broadcastQueue(room.id);
    });

    /* ---------------- queue ---------------- */

    socket.on('queue:add', (payload: unknown) => {
      if (!guard('queue')) return;
      if (!state.queueBucket.allow()) {
        socket.emit('toast', { type: 'error', message: 'Slow down a moment - too many queue changes' });
        return;
      }
      const parsed = queueAddSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit('toast', {
          type: 'error',
          message: parsed.error.issues[0]?.message || 'That item could not be added',
        });
        return;
      }
      const room = currentRoom()!;
      const items = parsed.data.items as MediaItem[];
      // Asked before adding: afterwards the new item itself makes the room look busy.
      const idle = roomIsIdle(room.id);

      const created = addToQueue(room.id, state.user.id, items, parsed.data.atTop ? 'next' : 'end');
      const label =
        items.length === 1
          ? `${state.user.displayName} added "${items[0].title}"`
          : `${state.user.displayName} added ${items.length} videos`;
      broadcastQueue(room.id, parsed.data.silent ? undefined : label);

      // Adding to a room that is not playing anything starts it straight away -
      // it used to be selected paused, which cost everyone an extra press.
      if (idle && created[0]) selectItem(room.id, created[0].id, true);
    });

    socket.on('queue:remove', (payload: { itemId?: string }) => {
      if (!guard('queue')) return;
      const room = currentRoom()!;
      const itemId = String(payload?.itemId || '');
      const row = db.prepare('SELECT * FROM queue_items WHERE id = ? AND room_id = ?').get(itemId, room.id) as
        | { id: string; added_by: string | null }
        | undefined;
      if (!row) return;

      const isCurrent = room.current_item_id === itemId;
      const upNext = isCurrent ? nextItemId(room.id, itemId, 'off') : null;
      removeQueueItem(room.id, itemId);

      if (isCurrent) {
        selectItem(room.id, upNext, upNext ? room.is_playing === 1 : false);
      } else {
        broadcastQueue(room.id);
      }
    });

    socket.on('queue:move', (payload: { itemId?: string; toIndex?: number }) => {
      if (!guard('queue')) return;
      const room = currentRoom()!;
      moveQueueItem(room.id, String(payload?.itemId || ''), Number(payload?.toIndex) || 0);
      broadcastQueue(room.id);
    });

    socket.on('queue:clear', (payload: { keepCurrent?: boolean }) => {
      if (!guard('queue')) return;
      const room = currentRoom()!;
      // A playlist episode is not in the queue: clearing the queue leaves it playing.
      if (room.playlist_id) {
        clearQueue(room.id, null);
      } else {
        const keep = payload?.keepCurrent === false ? null : room.current_item_id;
        clearQueue(room.id, keep);
        if (!keep) writePlayback(room.id, { currentItemId: null, isPlaying: false, position: 0 });
        emitPlayback(room.id);
      }
      broadcastQueue(room.id, `${state.user.displayName} cleared the queue`);
    });

    socket.on('queue:shuffle', () => {
      if (!guard('queue')) return;
      const room = currentRoom()!;
      shuffleQueue(room.id, room.playlist_id ? null : room.current_item_id);
      broadcastQueue(room.id, `${state.user.displayName} shuffled the queue`);
    });

    /* ---------------- chat + presence ---------------- */

    socket.on('chat:send', (payload: { body?: string }) => {
      const room = currentRoom();
      if (!room) return;
      const body = String(payload?.body || '').trim().slice(0, 2000);
      if (!body) return;
      if (!state.chatBucket.allow()) {
        socket.emit('toast', { type: 'error', message: 'You are sending messages too quickly' });
        return;
      }

      const id = newId();
      const now = Date.now();
      db.prepare('INSERT INTO messages (id, room_id, user_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        room.id,
        state.user.id,
        'chat',
        body,
        now
      );
      trimHistory(room.id);
      io?.to(`room:${room.id}`).emit('chat:message', {
        message: {
          id,
          userId: state.user.id,
          kind: 'chat',
          body,
          createdAt: now,
          displayName: state.user.displayName,
          avatarColor: state.user.avatarColor,
          avatarUrl: state.user.avatarUrl,
        },
      });
    });

    socket.on('chat:typing', (payload: { typing?: boolean }) => {
      const room = currentRoom();
      if (!room) return;
      socket.to(`room:${room.id}`).emit('chat:typing', {
        userId: state.user.id,
        displayName: state.user.displayName,
        typing: Boolean(payload?.typing),
      });
    });

    socket.on('player:buffering', (payload: { buffering?: boolean }) => {
      const room = currentRoom();
      if (!room) return;
      const next = Boolean(payload?.buffering);
      if (next === state.buffering) return;
      state.buffering = next;
      log.debug('buffering changed', { room: room.id, user: state.user.username, buffering: next });
      emitMembers(room.id);
      reconcileBuffering(room.id);
    });

    socket.on('sync:report', (payload: { position?: number }) => {
      const room = currentRoom();
      if (!room) return;
      state.reportedPosition = Number(payload?.position) || 0;
      state.reportedAt = Date.now();
    });

    socket.on('disconnect', (reason: string) => {
      const roomId = state.roomId;
      state.roomId = null;
      if (!roomId) return;
      // The reason is what tells "closed the tab" apart from "the tunnel timed
      // out mid-stream", which is the interesting case for sync complaints.
      log.info('disconnected', { room: roomId, user: state.user.username, reason });
      emitMembers(roomId);
      reconcileBuffering(roomId);
      if (!onlineUserIds(roomId).has(state.user.id)) {
        systemMessageTo(roomId, `${state.user.displayName} left`);
      }
      // Freeze an abandoned room, but only if it stays abandoned.
      if (onlineUserIds(roomId).size === 0) scheduleEmptyRoomFreeze(roomId);
    });
  });

  // Periodic resync: cheap, and it repairs drift caused by tab throttling.
  // The same tick credits watch time, so only genuinely playing, non-buffering
  // viewers accrue - and a client cannot inflate its own numbers.
  setInterval(() => {
    if (!io) return;
    for (const [key] of io.sockets.adapter.rooms) {
      if (!key.startsWith('room:')) continue;
      const roomId = key.slice(5);
      const payload = playbackPayload(roomId);
      if (payload) io.to(key).emit('player:tick', payload);

      giveUpOnStuckViewers(roomId);

      const room = roomById(roomId);
      if (!room || room.is_playing !== 1) continue;

      if (payload && overranTheEnd(roomId, room, payload)) {
        advance(roomId, 1);
        continue;
      }

      // Keep the playlist's bookmark current, so leaving mid-episode and coming
      // back tomorrow lands in the right place. Queue videos have no bookmark.
      if (payload && room.playlist_id && payload.item) {
        recordProgress(
          room.playlist_id,
          { source: payload.item.source, sourceId: payload.item.sourceId, title: payload.item.title },
          payload.position + (Date.now() - payload.stateAt) / 1000
        );
      }

      const watching = new Set<string>();
      for (const s of socketsIn(roomId)) {
        const st = socketState.get(s);
        // One person with two tabs open is still one person watching.
        if (st && !st.buffering) watching.add(st.user.id);
      }
      if (watching.size > 0) creditWatchTime(roomId, watching, TICK_SECONDS);
    }
  }, TICK_SECONDS * 1000);

  // Members payload carries live sync positions; refresh it at a slower rate.
  setInterval(() => {
    if (!io) return;
    for (const [key] of io.sockets.adapter.rooms) {
      if (key.startsWith('room:')) emitMembers(key.slice(5));
    }
  }, 10000);

  return io;
}

export function getIo(): Server | null {
  return io;
}
