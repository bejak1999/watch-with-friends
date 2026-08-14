import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelay: 700,
      reconnectionDelayMax: 6000,
      timeout: 12000,
    });
  }
  return socket;
}

export function closeSocket(): void {
  socket?.disconnect();
  socket = null;
}

/**
 * Estimates the offset between this browser's clock and the server's.
 * Uses the round trip with the lowest latency, which is the least distorted.
 */
export async function measureClockOffset(s: Socket, samples = 5): Promise<number> {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 };

  for (let i = 0; i < samples; i++) {
    const sent = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const result = await new Promise<{ serverNow: number } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      s.emit('time:sync', sent, (payload: { serverNow: number }) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    if (!result) continue;

    const received = Date.now();
    const rtt = received - sent;
    const offset = result.serverNow - (sent + rtt / 2);
    if (rtt < best.rtt) best = { rtt, offset };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 60));
  }

  return Number.isFinite(best.rtt) ? best.offset : 0;
}
