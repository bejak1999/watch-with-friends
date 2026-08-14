import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import type { PlaybackState, QueueItem } from '../../lib/api';
import { createAdapter, type Adapter, type QualityOption } from './adapters';

export interface SyncPlayerHandle {
  /** Change the local rendition. Never synced - each viewer has their own line. */
  setQuality(id: string): void;
  /** Local player position in seconds, used by the scrub bar. */
  getTime(): number;
  getDuration(): number;
  /** Drift against the room clock, in seconds. Positive means we are ahead. */
  getDrift(): number;
  isReady(): boolean;
}

interface Props {
  item: QueueItem | null;
  playback: PlaybackState;
  /** Date.now() + offset == the server's clock. */
  serverOffset: number;
  /** Playback only starts after the viewer has interacted with the page once. */
  armed: boolean;
  volume: number;
  muted: boolean;
  onEnded: (itemId: string) => void;
  onBuffering: (buffering: boolean) => void;
  onDuration: (itemId: string, seconds: number) => void;
  onError: (message: string) => void;
  onReport: (position: number) => void;
  /** Reports the resolutions this source can offer, once they are known. */
  onQualities: (options: QualityOption[], activeId: string) => void;
}

/** Beyond this the player is jumped rather than nudged. */
const HARD_SEEK_DRIFT = 2.0;
/** Players without fine rate control (YouTube, Twitch) get a wider dead zone. */
const COARSE_SEEK_DRIFT = 1.2;
const NUDGE_DRIFT = 0.35;

export const SyncPlayer = forwardRef<SyncPlayerHandle, Props>(function SyncPlayer(
  {
    item,
    playback,
    serverOffset,
    armed,
    volume,
    muted,
    onEnded,
    onBuffering,
    onDuration,
    onError,
    onReport,
    onQualities,
  },
  ref
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<Adapter | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Latest props read inside intervals without re-creating the player.
  const live = useRef({ playback, serverOffset, armed, volume, muted, item });
  live.current = { playback, serverOffset, armed, volume, muted, item };

  const driftRef = useRef(0);
  const bufferingSince = useRef(0);
  const reportedBuffering = useRef(false);
  const lastSeekAt = useRef(0);
  const appliedRate = useRef(1);

  /* ---- adapter lifecycle: rebuild whenever the track changes ---- */
  useEffect(() => {
    setReady(false);
    setLoadError(null);
    onQualities([], 'auto');
    driftRef.current = 0;
    reportedBuffering.current = false;
    onBuffering(false);

    if (!item || !mountRef.current) {
      adapterRef.current?.destroy();
      adapterRef.current = null;
      return;
    }

    const mount = mountRef.current;
    const adapter = createAdapter(mount, item, {
      onReady: () => {
        setReady(true);
        const { playback: pb, serverOffset: off, armed: isArmed, volume: vol, muted: isMuted } = live.current;
        adapter.setVolume(vol);
        adapter.setMuted(isMuted);
        adapter.setRate(pb.rate || 1);
        appliedRate.current = pb.rate || 1;
        const target = expectedPosition(pb, off);
        if (!adapter.isLive && target > 0.5) adapter.seek(target);
        if (pb.isPlaying && isArmed) adapter.play();
      },
      onEnded: () => onEnded(item.id),
      onBuffering: (b) => {
        if (b) {
          if (bufferingSince.current === 0) bufferingSince.current = Date.now();
        } else {
          bufferingSince.current = 0;
          if (reportedBuffering.current) {
            reportedBuffering.current = false;
            onBuffering(false);
          }
        }
      },
      onDuration: (seconds) => {
        if (!item.duration || item.duration <= 0) onDuration(item.id, seconds);
      },
      onError: (message) => {
        setLoadError(message);
        onError(message);
      },
      onQualities: (options, activeId) => onQualities(options, activeId),
    });

    adapterRef.current = adapter;
    return () => {
      adapter.destroy();
      if (adapterRef.current === adapter) adapterRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.source, item?.sourceId]);

  /* ---- volume / mute ---- */
  useEffect(() => {
    adapterRef.current?.setVolume(volume);
  }, [volume, ready]);

  useEffect(() => {
    adapterRef.current?.setMuted(muted);
  }, [muted, ready]);

  /* ---- react to explicit play/pause/seek from the room ---- */
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter || !adapter.ready) return;
    if (!armed) {
      adapter.pause();
      return;
    }
    if (playback.isPlaying) {
      const target = expectedPosition(playback, serverOffset);
      if (!adapter.isLive && Math.abs(adapter.getTime() - target) > HARD_SEEK_DRIFT) {
        adapter.seek(target);
        lastSeekAt.current = Date.now();
      }
      adapter.play();
    } else {
      adapter.pause();
      if (!adapter.isLive && Math.abs(adapter.getTime() - playback.position) > 0.6) {
        adapter.seek(playback.position);
        lastSeekAt.current = Date.now();
      }
    }
    // stateAt changes on every server update, which is exactly when we resync.
  }, [playback.isPlaying, playback.position, playback.stateAt, armed, ready, serverOffset]);

  /* ---- rate ---- */
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter?.ready || !adapter.supportsRate) return;
    adapter.setRate(playback.rate || 1);
    appliedRate.current = playback.rate || 1;
  }, [playback.rate, ready]);

  /* ---- drift correction loop ---- */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const adapter = adapterRef.current;
      const { playback: pb, serverOffset: off, armed: isArmed } = live.current;
      if (!adapter || !adapter.ready) return;

      const localTime = adapter.getTime();
      onReport(localTime);

      // A stall that outlasts the grace period tells the room to wait for us.
      if (bufferingSince.current > 0 && !reportedBuffering.current && Date.now() - bufferingSince.current > 900) {
        reportedBuffering.current = true;
        onBuffering(true);
      }

      if (adapter.isLive || !isArmed) return;

      const target = expectedPosition(pb, off);
      const drift = localTime - target;
      driftRef.current = drift;

      if (!pb.isPlaying) return;
      // Give a fresh seek time to settle before judging drift again.
      if (Date.now() - lastSeekAt.current < 1200) return;

      const seekThreshold = adapter.supportsFineRate ? HARD_SEEK_DRIFT : COARSE_SEEK_DRIFT;

      if (Math.abs(drift) > seekThreshold) {
        adapter.seek(target + 0.25);
        lastSeekAt.current = Date.now();
        if (adapter.supportsRate) adapter.setRate(pb.rate || 1);
        appliedRate.current = pb.rate || 1;
        return;
      }

      if (adapter.supportsFineRate) {
        const base = pb.rate || 1;
        const wanted = Math.abs(drift) > NUDGE_DRIFT ? base * (drift > 0 ? 0.94 : 1.06) : base;
        if (Math.abs(wanted - appliedRate.current) > 0.01) {
          adapter.setRate(wanted);
          appliedRate.current = wanted;
        }
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [onBuffering, onReport]);

  useImperativeHandle(
    ref,
    () => ({
      setQuality: (id: string) => adapterRef.current?.setQuality?.(id),
      getTime: () => adapterRef.current?.getTime() ?? 0,
      getDuration: () => adapterRef.current?.getDuration() ?? 0,
      getDrift: () => driftRef.current,
      isReady: () => Boolean(adapterRef.current?.ready),
    }),
    []
  );

  return (
    <>
      <div className="player-mount" ref={mountRef} />
      {loadError && (
        <div className="stage-overlay">
          <div className="inner">
            <div style={{ fontSize: '1.8rem' }}>⚠️</div>
            <div style={{ fontWeight: 600 }}>{loadError}</div>
            <div className="small faint">Skip to the next item in the queue, or try a different link.</div>
          </div>
        </div>
      )}
    </>
  );
});

export function expectedPosition(pb: PlaybackState, serverOffset: number): number {
  if (!pb.isPlaying) return Math.max(0, pb.position);
  const serverNow = Date.now() + serverOffset;
  const elapsed = Math.max(0, serverNow - pb.stateAt) / 1000;
  return Math.max(0, pb.position + elapsed * (pb.rate || 1));
}
