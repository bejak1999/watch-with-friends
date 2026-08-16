import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import type { PlaybackState, QueueItem } from '../../lib/api';
import { createAdapter, type Adapter, type QualityOption } from './adapters';

export interface SyncPlayerHandle {
  /** Change the local rendition. Never synced - each viewer has their own line. */
  setQuality(id: string): void;
  /** Show or hide subtitles, for this viewer only. */
  setCaptions(enabled: boolean): void;
  /** Local player position in seconds, used by the scrub bar. */
  getTime(): number;
  getDuration(): number;
  /** Seconds downloaded from zero, for the grey loaded bar. */
  getBuffered(): number;
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
  /** May this viewer move the room? Decides jump propagation. */
  canControl: boolean;
  /** An extension moved our playhead; carry the room with us. */
  onExternalSeek: (position: number) => void;
  /** One-off explanation shown to the viewer. */
  onNotice: (message: string) => void;
  /** Reports the resolutions this source can offer, once they are known. */
  onQualities: (options: QualityOption[], activeId: string) => void;
  /** Whether this source has subtitles at all, so the button can hide. */
  onCaptionsAvailable: (available: boolean) => void;
  captionsOn: boolean;
}

/** Beyond this the player is jumped rather than nudged. */
const HARD_SEEK_DRIFT = 2.0;
/** Players without fine rate control (YouTube, Twitch) get a wider dead zone. */
const COARSE_SEEK_DRIFT = 1.2;
const NUDGE_DRIFT = 0.35;
/** A playhead move this large in one 400ms tick was not caused by playback. */
const EXTERNAL_JUMP = 1.5;
/** Cap propagated jumps so a misbehaving player cannot spam the room. */
const JUMP_BUDGET = 12;

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
    canControl,
    onExternalSeek,
    onNotice,
    onCaptionsAvailable,
    captionsOn,
  },
  ref
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<Adapter | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Latest props read inside intervals without re-creating the player.
  const live = useRef({ playback, serverOffset, armed, volume, muted, item, canControl, captionsOn });
  live.current = { playback, serverOffset, armed, volume, muted, item, canControl, captionsOn };

  const driftRef = useRef(0);
  const bufferingSince = useRef(0);
  const reportedBuffering = useRef(false);
  const lastSeekAt = useRef(0);
  const appliedRate = useRef(1);
  /** Previous playhead reading, used to tell playback apart from a jump. */
  const lastSample = useRef<{ time: number; at: number } | null>(null);
  const stalledSince = useRef(0);
  const jumpBudget = useRef(JUMP_BUDGET);
  const warnedNoControl = useRef(false);

  /* ---- adapter lifecycle: rebuild whenever the track changes ---- */
  useEffect(() => {
    setReady(false);
    setLoadError(null);
    onQualities([], 'auto');
    onCaptionsAvailable(false);
    driftRef.current = 0;
    lastSample.current = null;
    stalledSince.current = 0;
    jumpBudget.current = JUMP_BUDGET;
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
        adapter.setCaptions?.(live.current.captionsOn);
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
      onCaptionsAvailable: (available) => onCaptionsAvailable(available),
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

  useEffect(() => {
    adapterRef.current?.setCaptions?.(captionsOn);
  }, [captionsOn, ready]);

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
      lastSample.current = null;
      }
      adapter.play();
    } else {
      adapter.pause();
      if (!adapter.isLive && Math.abs(adapter.getTime() - playback.position) > 0.6) {
        adapter.seek(playback.position);
        lastSeekAt.current = Date.now();
      lastSample.current = null;
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

      /* ---- what did the playhead do since the last tick? ---- */
      const now = Date.now();
      const sample = lastSample.current;
      const settled = now - lastSeekAt.current > 1200;
      lastSample.current = { time: localTime, at: now };

      if (pb.isPlaying && sample && settled) {
        const elapsed = (now - sample.at) / 1000;
        const expectedAdvance = elapsed * (pb.rate || 1);
        const actualAdvance = localTime - sample.time;
        const unexplained = actualAdvance - expectedAdvance;

        // A browser extension (SponsorBlock and friends) moves the playhead by
        // setting currentTime. Left alone we would drag it back every 400ms and
        // fight the extension forever, so treat the jump as a seek instead.
        if (Math.abs(unexplained) > EXTERNAL_JUMP) {
          if (live.current.canControl && jumpBudget.current > 0) {
            jumpBudget.current -= 1;
            lastSeekAt.current = now;
            onExternalSeek(localTime);
            return;
          }
          if (!warnedNoControl.current) {
            warnedNoControl.current = true;
            onNotice(
              'Something in your browser skipped ahead - probably SponsorBlock. ' +
                'Only hosts can move the room, so you were pulled back in line.'
            );
          }
        }

        // Time frozen while the room plays means an ad, a decode stall or a
        // throttled tab. Tell the room so "wait for everyone" can hold.
        if (Math.abs(actualAdvance) < 0.05 && elapsed > 0.3) {
          if (stalledSince.current === 0) stalledSince.current = now;
          if (now - stalledSince.current > 2500 && !reportedBuffering.current) {
            reportedBuffering.current = true;
            onBuffering(true);
          }
        } else if (stalledSince.current !== 0) {
          stalledSince.current = 0;
        }
      }

      /**
       * Clearing has to live outside the block above. Reporting a stall makes
       * the server pause the room, which flips isPlaying to false - so a clear
       * path gated on isPlaying can never run, and the room stays "waiting for
       * everyone" forever. Ask the player directly instead.
       */
      // A paused room has nothing to wait for, so any stall measurement is void.
      if (!pb.isPlaying) stalledSince.current = 0;

      const stillStuck = bufferingSince.current !== 0 || (pb.isPlaying && stalledSince.current !== 0);
      if (reportedBuffering.current && !stillStuck) {
        reportedBuffering.current = false;
        onBuffering(false);
      }

      if (!pb.isPlaying) return;
      // Give a fresh seek time to settle before judging drift again.
      if (!settled) return;

      const seekThreshold = adapter.supportsFineRate ? HARD_SEEK_DRIFT : COARSE_SEEK_DRIFT;

      if (Math.abs(drift) > seekThreshold) {
        adapter.seek(target + 0.25);
        lastSeekAt.current = Date.now();
      lastSample.current = null;
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
  }, [onBuffering, onReport, onExternalSeek, onNotice]);

  useImperativeHandle(
    ref,
    () => ({
      setQuality: (id: string) => adapterRef.current?.setQuality?.(id),
      setCaptions: (enabled: boolean) => adapterRef.current?.setCaptions?.(enabled),
      getTime: () => adapterRef.current?.getTime() ?? 0,
      getDuration: () => adapterRef.current?.getDuration() ?? 0,
      getBuffered: () => adapterRef.current?.getBuffered?.() ?? 0,
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
