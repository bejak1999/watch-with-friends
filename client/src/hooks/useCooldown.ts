import { useCallback, useEffect, useState } from 'react';

/**
 * Counts a lockout down to zero once a second so the form can show the wait
 * and re-enable itself without a reload.
 */
export function useCooldown() {
  const [until, setUntil] = useState(0);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (until === 0) {
      setRemaining(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setUntil(0);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [until]);

  const start = useCallback((seconds: number | undefined) => {
    if (!seconds || seconds <= 0) return;
    setUntil(Date.now() + seconds * 1000);
  }, []);

  const clear = useCallback(() => setUntil(0), []);

  return { remaining, active: remaining > 0, start, clear };
}

export function formatCooldown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
