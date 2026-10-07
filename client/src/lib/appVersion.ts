import { useEffect, useState } from 'react';

/** The build this page came from. */
export const PAGE_COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';

let serverCommit: string | null = null;
const listeners = new Set<() => void>();

/** The server says which build it runs every time the socket connects. */
export function noteServerCommit(commit: string): void {
  if (commit === serverCommit) return;
  serverCommit = commit;
  listeners.forEach((fn) => fn());
}

function isStale(): boolean {
  return Boolean(serverCommit && serverCommit !== 'dev' && PAGE_COMMIT !== 'dev' && serverCommit !== PAGE_COMMIT);
}

/**
 * True when the server was updated after this page was loaded. The old page
 * keeps running old player code against the new server until it is reloaded,
 * which is a fine source of "only I have this problem".
 */
export function useStalePage(): boolean {
  const [stale, setStale] = useState(isStale);
  useEffect(() => {
    const update = () => setStale(isStale());
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return stale;
}
