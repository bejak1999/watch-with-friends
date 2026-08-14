import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket, measureClockOffset } from '../lib/socket';
import type { ChatMessage, MediaItem, Member, PlaybackState, QueueItem, RoomSnapshot } from '../lib/api';

export type RoomStatus = 'connecting' | 'ready' | 'error' | 'kicked';

interface JoinResponse {
  room?: RoomSnapshot;
  queue?: QueueItem[];
  messages?: ChatMessage[];
  members?: Member[];
  error?: string;
}

export interface RoomActions {
  play(position?: number): void;
  pause(position?: number): void;
  seek(position: number): void;
  setRate(rate: number): void;
  select(itemId: string, autoplay?: boolean): void;
  next(): void;
  prev(): void;
  setRepeat(mode: 'off' | 'one' | 'all'): void;
  addToQueue(items: MediaItem[], atTop?: boolean): void;
  removeFromQueue(itemId: string): void;
  moveInQueue(itemId: string, toIndex: number): void;
  clearQueue(keepCurrent: boolean): void;
  shuffleQueue(): void;
  sendChat(body: string): void;
  setTyping(typing: boolean): void;
  reportEnded(itemId: string): void;
  reportBuffering(buffering: boolean): void;
  reportDuration(itemId: string, seconds: number): void;
  reportPosition(position: number): void;
}

export function useRoom(roomId: string | undefined) {
  const [status, setStatus] = useState<RoomStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [playback, setPlayback] = useState<PlaybackState>({
    currentItemId: null,
    isPlaying: false,
    position: 0,
    rate: 1,
    stateAt: Date.now(),
    repeatMode: 'off',
    shuffle: false,
  });
  const [serverOffset, setServerOffset] = useState(0);
  const [waitingForBuffer, setWaitingForBuffer] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const typingTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!roomId) return;
    const socket = getSocket();
    socketRef.current = socket;
    let cancelled = false;

    const join = () => {
      socket.emit('room:join', { roomId }, (res: JoinResponse) => {
        if (cancelled) return;
        if (res?.error) {
          setError(res.error);
          setStatus('error');
          return;
        }
        setRoom(res.room ?? null);
        setQueue(res.queue ?? []);
        setMessages(res.messages ?? []);
        setMembers(res.members ?? []);
        if (res.room?.playback) setPlayback(res.room.playback);
        setStatus('ready');
        setError(null);
      });
      void measureClockOffset(socket).then((offset) => {
        if (!cancelled) setServerOffset(offset);
      });
    };

    const onConnect = () => {
      setConnected(true);
      join();
    };
    const onDisconnect = () => setConnected(false);
    const onConnectError = (err: Error) => {
      setConnected(false);
      if (err.message === 'unauthorised') {
        setError('Your session expired. Reload the page and sign in again.');
        setStatus('error');
      }
    };

    const onPlayerState = (p: PlaybackState) => {
      setPlayback(p);
    };
    const onQueueState = (p: { queue: QueueItem[] }) => setQueue(p.queue);
    const onMembersState = (p: { members: Member[] }) => setMembers(p.members);
    const onChatMessage = (p: { message: ChatMessage }) => {
      setMessages((prev) => [...prev.slice(-400), p.message]);
      if (p.message.userId) {
        setTypingUsers((prev) => {
          if (!prev[p.message.userId!]) return prev;
          const next = { ...prev };
          delete next[p.message.userId!];
          return next;
        });
      }
    };
    const onRoomUpdated = (p: { room: RoomSnapshot }) => setRoom(p.room);
    const onKicked = (p: { reason: string }) => {
      setError(p.reason);
      setStatus('kicked');
    };
    const onWaiting = (p: { waiting: boolean }) => setWaitingForBuffer(p.waiting);
    const onTyping = (p: { userId: string; displayName: string; typing: boolean }) => {
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (p.typing) next[p.userId] = p.displayName;
        else delete next[p.userId];
        return next;
      });
      window.clearTimeout(typingTimers.current[p.userId]);
      if (p.typing) {
        typingTimers.current[p.userId] = window.setTimeout(() => {
          setTypingUsers((prev) => {
            const next = { ...prev };
            delete next[p.userId];
            return next;
          });
        }, 5000);
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('player:state', onPlayerState);
    socket.on('player:tick', onPlayerState);
    socket.on('queue:state', onQueueState);
    socket.on('members:state', onMembersState);
    socket.on('chat:message', onChatMessage);
    socket.on('room:updated', onRoomUpdated);
    socket.on('room:kicked', onKicked);
    socket.on('sync:waiting', onWaiting);
    socket.on('chat:typing', onTyping);

    if (socket.connected) onConnect();
    else socket.connect();

    // Clocks drift; re-measure occasionally so long sessions stay tight.
    const resyncTimer = window.setInterval(() => {
      if (socket.connected) {
        void measureClockOffset(socket, 3).then((offset) => {
          if (!cancelled) setServerOffset(offset);
        });
      }
    }, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(resyncTimer);
      socket.emit('room:leave');
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('player:state', onPlayerState);
      socket.off('player:tick', onPlayerState);
      socket.off('queue:state', onQueueState);
      socket.off('members:state', onMembersState);
      socket.off('chat:message', onChatMessage);
      socket.off('room:updated', onRoomUpdated);
      socket.off('room:kicked', onKicked);
      socket.off('sync:waiting', onWaiting);
      socket.off('chat:typing', onTyping);
    };
  }, [roomId]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload ?? {});
  }, []);

  const actions = useMemo<RoomActions>(
    () => ({
      play: (position) => emit('player:play', { position }),
      pause: (position) => emit('player:pause', { position }),
      seek: (position) => emit('player:seek', { position }),
      setRate: (rate) => emit('player:rate', { rate }),
      select: (itemId, autoplay = true) => emit('player:select', { itemId, autoplay }),
      next: () => emit('player:next'),
      prev: () => emit('player:prev'),
      setRepeat: (mode) => emit('player:repeat', { mode }),
      addToQueue: (items, atTop) => emit('queue:add', { items, atTop }),
      removeFromQueue: (itemId) => emit('queue:remove', { itemId }),
      moveInQueue: (itemId, toIndex) => emit('queue:move', { itemId, toIndex }),
      clearQueue: (keepCurrent) => emit('queue:clear', { keepCurrent }),
      shuffleQueue: () => emit('queue:shuffle'),
      sendChat: (body) => emit('chat:send', { body }),
      setTyping: (typing) => emit('chat:typing', { typing }),
      reportEnded: (itemId) => emit('player:ended', { itemId }),
      reportBuffering: (buffering) => emit('player:buffering', { buffering }),
      reportDuration: (itemId, seconds) => emit('media:duration', { itemId, duration: seconds }),
      reportPosition: (position) => emit('sync:report', { position }),
    }),
    [emit]
  );

  const currentItem = useMemo(
    () => queue.find((q) => q.id === playback.currentItemId) ?? null,
    [queue, playback.currentItemId]
  );

  return {
    status,
    error,
    connected,
    room,
    setRoom,
    queue,
    messages,
    members,
    playback,
    serverOffset,
    waitingForBuffer,
    typingUsers,
    currentItem,
    actions,
  };
}
