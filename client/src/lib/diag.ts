/**
 * Playback diagnostics, sent to the server log.
 *
 * Problems like "the tab went quiet in the background" or "black picture, only
 * subtitles" happen in one browser, not on the server, and are gone by the time
 * anybody looks. So the page reports what it sees - visibility, the browser
 * freezing the tab, the player refusing sound, stalls, black pictures, errors,
 * the connection dropping - and the admin log lines it up with the server's
 * side (scope "client").
 *
 * Events raised while offline are kept and sent once the socket is back, with
 * their original time, which is exactly when the interesting ones happen.
 */

import type { Socket } from 'socket.io-client';

export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEvent {
  at: number;
  kind: string;
  level: DiagLevel;
  hidden: boolean;
  detail?: Record<string, unknown>;
}

const LOCAL_KEEP = 200;
const PENDING_KEEP = 120;

const local: DiagEvent[] = [];
const pending: DiagEvent[] = [];
const listeners = new Set<() => void>();
let socket: Socket | null = null;
let flushTimer: number | undefined;

export function diag(kind: string, detail?: Record<string, unknown>, level: DiagLevel = 'info'): void {
  const event: DiagEvent = {
    at: Date.now(),
    kind,
    level,
    hidden: typeof document !== 'undefined' && document.visibilityState !== 'visible',
    detail,
  };
  local.push(event);
  if (local.length > LOCAL_KEEP) local.splice(0, local.length - LOCAL_KEEP);
  pending.push(event);
  if (pending.length > PENDING_KEEP) pending.splice(0, pending.length - PENDING_KEEP);
  listeners.forEach((fn) => fn());
  if (level !== 'info') console.warn(`[diag] ${kind}`, detail ?? '');
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  // Batch bursts (a stall, then the recovery) into one message.
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    flush();
  }, 400);
}

function flush(): void {
  if (!socket?.connected || pending.length === 0) return;
  socket.emit('diag:events', { events: pending.splice(0, 30) });
  if (pending.length > 0) scheduleFlush();
}

/** The last couple of hundred events, newest last - for the diagnostics panel. */
export function recentDiag(): DiagEvent[] {
  return local.slice();
}

export function subscribeDiag(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called once by the socket module, so connection drops are reported too. */
export function attachDiagSocket(s: Socket): void {
  socket = s;
  let lostAt = 0;
  s.on('disconnect', (reason: string) => {
    lostAt = Date.now();
    diag('socket-lost', { reason }, reason === 'io client disconnect' ? 'info' : 'warn');
  });
  s.on('connect', () => {
    if (lostAt) diag('socket-back', { downForS: Math.round((Date.now() - lostAt) / 1000) });
    lostAt = 0;
    flush();
  });
}

let installed = false;

/** Page-level signals: background/foreground, the browser freezing the tab, network. */
export function installPageDiagnostics(): void {
  if (installed) return;
  installed = true;

  let hiddenAt = document.visibilityState === 'visible' ? 0 : Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      diag('page-visible', hiddenAt ? { hiddenForS: Math.round((Date.now() - hiddenAt) / 1000) } : undefined);
      hiddenAt = 0;
    } else {
      hiddenAt = Date.now();
      diag('page-hidden');
    }
  });

  // Page Lifecycle (Chromium): the browser stopped running this tab entirely -
  // Edge "sleeping tabs", Chrome energy saver. Nothing runs while frozen, so
  // the freeze is only known once it resumes.
  let frozenAt = 0;
  document.addEventListener('freeze', () => {
    frozenAt = Date.now();
  });
  document.addEventListener('resume', () => {
    diag('page-unfrozen', frozenAt ? { frozenForS: Math.round((Date.now() - frozenAt) / 1000) } : undefined, 'warn');
    frozenAt = 0;
  });

  window.addEventListener('offline', () => diag('network-offline', undefined, 'warn'));
  window.addEventListener('online', () => diag('network-online'));
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted) diag('page-restored-from-cache');
  });
  window.addEventListener('error', (e) => {
    diag('page-error', { message: String(e.message).slice(0, 200), at: `${e.filename?.split('/').pop()}:${e.lineno}` }, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
    diag('page-unhandled-rejection', { message: reason.slice(0, 200) }, 'warn');
  });
}
