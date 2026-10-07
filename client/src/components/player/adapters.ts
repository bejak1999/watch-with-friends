import type { QueueItem } from '../../lib/api';
import { diag } from '../../lib/diag';

const isVisible = () => document.visibilityState === 'visible';
/** The page has had a click or key press: browsers then allow sound, even in a background tab. */
const hadGesture = () =>
  Boolean((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive);

export interface QualityOption {
  id: string;
  label: string;
}

export interface AdapterCallbacks {
  /** Fired once the player knows which resolutions it can offer. */
  onQualities?: (options: QualityOption[], activeId: string) => void;
  /** Fired when the player reveals whether it has subtitles at all. */
  onCaptionsAvailable?: (available: boolean) => void;
  onReady: () => void;
  onEnded: () => void;
  onBuffering: (buffering: boolean) => void;
  onDuration: (seconds: number) => void;
  /** Fired when the embedded player changed state on its own (user clicked it). */
  onLocalIntent?: (intent: 'play' | 'pause') => void;
  /**
   * The browser refused to play with sound, so the player fell back to muted.
   * Reported so the room can offer a click to turn it back on - it used to
   * happen silently, leaving a picture with no sound and no hint why.
   */
  onSoundBlocked?: (blocked: boolean) => void;
  /**
   * `kind` matters: an embed refusal is the one failure the app can route
   * around, by streaming the video through the server instead.
   */
  onError: (message: string, kind?: 'embed-refused' | 'other') => void;
}

export interface Adapter {
  readonly kind: string;
  readonly supportsRate: boolean;
  /** True when arbitrary rates work, so small drift can be nudged instead of seeked. */
  readonly supportsFineRate: boolean;
  readonly isLive: boolean;
  ready: boolean;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  getTime(): number;
  getDuration(): number;
  /**
   * How far ahead the player has downloaded, in seconds from zero. Drives the
   * grey "loaded" bar. Return 0 when the player cannot tell us.
   */
  getBuffered?(): number;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setRate(rate: number): void;
  /** Resolution is a per-viewer choice, never synced - bandwidth differs. */
  setQuality?(id: string): void;
  /** Subtitles are personal too. Undefined means the source has none. */
  setCaptions?(enabled: boolean): void;
  readonly supportsCaptions?: boolean;
  /** Turn sound back on after the browser blocked it. Must run inside a click. */
  unmute?(): void;
  /** What the element knows about its sound, for the diagnostics panel. */
  getAudioInfo?(): AudioInfo;
  /** Muted by us because the browser refused sound (not by the viewer). */
  isSoundBlocked?(): boolean;
  /**
   * The tab is back in front: get going again if the browser stopped us in
   * the background, and repaint a picture that went black meanwhile.
   */
  recover?(): void;
  /** A snapshot of the player's own state, for diagnostics. */
  describe?(): Record<string, unknown>;
  destroy(): void;
}

export interface AudioInfo {
  muted: boolean;
  /** Chromium only: audio bytes decoded so far. Rising means sound is flowing. */
  audioBytes: number | null;
  /** Firefox only: whether the element has an audio track at all. */
  hasAudio: boolean | null;
}

/* ---------------------------------------------------------------- */
/* Script loading                                                    */
/* ---------------------------------------------------------------- */

const scriptCache = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const cached = scriptCache.get(src);
  if (cached) return cached;
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      scriptCache.delete(src);
      reject(new Error(`Could not load ${src}`));
    };
    document.head.appendChild(el);
  });
  scriptCache.set(src, promise);
  return promise;
}

/* ---------------------------------------------------------------- */
/* YouTube                                                           */
/* ---------------------------------------------------------------- */

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
    Twitch?: any;
  }
}

const YT_QUALITY_LABELS: Record<string, string> = {
  tiny: '144p', small: '240p', medium: '360p', large: '480p',
  hd720: '720p', hd1080: '1080p', hd1440: '1440p', hd2160: '2160p', highres: 'Max',
};

let ytReady: Promise<void> | null = null;

function loadYouTubeApi(): Promise<void> {
  if (ytReady) return ytReady;
  ytReady = new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    loadScript('https://www.youtube.com/iframe_api').catch(reject);
  });
  return ytReady;
}

class YouTubeAdapter implements Adapter {
  readonly kind = 'youtube';
  readonly supportsRate = true;
  readonly supportsFineRate = false;
  readonly isLive = false;
  ready = false;

  private player: any = null;
  private destroyed = false;
  private lastState = -1;
  private captionsWanted = false;
  /** The room wants this playing; cleared by pause, checked by the autoplay probe. */
  private wantsPlay = false;
  /** Muted by us because the browser refused sound, not by the viewer. */
  private soundBlocked = false;
  private autoplayProbe: ReturnType<typeof setTimeout> | undefined;
  /** How often a not-starting player was nudged before concluding sound is blocked. */
  private nudges = 0;
  /** A probe that came due in a background tab, to be run once it is visible. */
  private probeOnVisible = false;
  private readonly onVisibility = () => {
    if (isVisible() && this.probeOnVisible) {
      this.probeOnVisible = false;
      this.player?.playVideo?.();
      this.scheduleProbe(1500);
    }
  };

  constructor(
    private mount: HTMLElement,
    private videoId: string,
    private cb: AdapterCallbacks
  ) {
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.init();
  }

  private async init() {
    try {
      await loadYouTubeApi();
    } catch {
      this.cb.onError('YouTube could not be reached. Check your internet connection.');
      return;
    }
    if (this.destroyed) return;

    const host = document.createElement('div');
    this.mount.appendChild(host);

    this.player = new window.YT.Player(host, {
      videoId: this.videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        fs: 0,
        playsinline: 1,
        iv_load_policy: 3,
        cc_load_policy: 0,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          if (this.destroyed) return;
          this.ready = true;
          const d = this.player.getDuration?.();
          if (d > 0) this.cb.onDuration(d);
          // Offer the control straight away. YouTube only fills in its track
          // list after the caption module loads, so waiting for a definitive
          // answer would mean no CC button until the user hits play - which is
          // exactly when they want it, because that is when subtitles appear.
          this.cb.onCaptionsAvailable?.(true);
          this.applyCaptions();
          this.cb.onReady();
        },
        onStateChange: (e: { data: number }) => {
          if (this.destroyed) return;
          const YT = window.YT.PlayerState;
          if (e.data === YT.BUFFERING) this.cb.onBuffering(true);
          if (e.data === YT.PLAYING || e.data === YT.PAUSED || e.data === YT.CUED) this.cb.onBuffering(false);
          if (e.data === YT.ENDED) this.cb.onEnded();
          if (e.data === YT.PLAYING && this.lastState === YT.PAUSED) this.cb.onLocalIntent?.('play');
          if (e.data === YT.PAUSED && this.lastState === YT.PLAYING) this.cb.onLocalIntent?.('pause');
          if (e.data === YT.PLAYING) {
            const d = this.player.getDuration?.();
            if (d > 0) this.cb.onDuration(d);
            this.publishQualities();
            // YouTube re-adds the module when playback starts, so re-assert.
            this.applyCaptions();
            this.cb.onCaptionsAvailable?.(true);
          }
          this.lastState = e.data;
        },
        onError: (e: { data: number }) => {
          diag('player-error', { player: 'youtube', code: e.data }, 'warn');
          const messages: Record<number, string> = {
            2: 'That YouTube video id is invalid',
            5: 'YouTube cannot play this video in an embedded player',
            100: 'That YouTube video was removed or is private',
            101: 'The uploader does not allow this video to be embedded',
            150: 'The uploader does not allow this video to be embedded',
          };
          // 101 and 150 are the same refusal reported through two code paths.
          const refused = e.data === 101 || e.data === 150 || e.data === 5;
          this.cb.onError(messages[e.data] || 'YouTube could not play this video', refused ? 'embed-refused' : 'other');
        },
      },
    });
  }

  /**
   * YouTube gives no error when a browser refuses to start it with sound - the
   * player just stays put. Left alone, that viewer looked like they were
   * buffering and held the whole room, so a player that does not start falls
   * back to muted playback and says so.
   *
   * But "did not start" is only evidence of a sound block in a tab you are
   * looking at, on a page nobody has clicked yet. In a background tab the
   * browser simply holds media back until the tab is shown, and after any
   * click sound is allowed anyway - the old probe muted those viewers for no
   * reason. A muted tab then counts as silent to the browser, which pauses,
   * throttles or freezes it: black picture, subtitles still running, room
   * waiting. So: judge only when visible, nudge a few times after a click,
   * and mute only as a last resort.
   */
  play() {
    this.wantsPlay = true;
    this.nudges = 0;
    this.player?.playVideo?.();
    this.scheduleProbe(1500);
  }

  private scheduleProbe(ms: number) {
    clearTimeout(this.autoplayProbe);
    this.autoplayProbe = setTimeout(() => this.probe(), ms);
  }

  private probe() {
    if (this.destroyed || !this.wantsPlay || !this.player) return;
    const state = this.player.getPlayerState?.();
    // -1 unstarted, 5 cued, 2 paused: asked to play, did not.
    const notStarted = state === -1 || state === 5 || state === 2;
    if (!notStarted) return;
    if (!isVisible()) {
      this.probeOnVisible = true;
      diag('yt-waiting-for-tab', { state });
      return;
    }
    if (hadGesture() && this.nudges < 3) {
      this.nudges += 1;
      diag('yt-not-started', { state, nudge: this.nudges }, this.nudges > 1 ? 'warn' : 'info');
      this.player.playVideo?.();
      this.scheduleProbe(2000);
      return;
    }
    if (this.player.isMuted?.()) return;
    this.soundBlocked = true;
    this.player.mute?.();
    this.player.playVideo?.();
    diag('sound-blocked', { player: 'youtube', state, hadGesture: hadGesture(), nudges: this.nudges }, 'warn');
    this.cb.onSoundBlocked?.(true);
  }

  pause() {
    this.wantsPlay = false;
    this.probeOnVisible = false;
    clearTimeout(this.autoplayProbe);
    this.player?.pauseVideo?.();
  }

  unmute() {
    this.soundBlocked = false;
    this.player?.unMute?.();
    this.player?.playVideo?.();
    diag('sound-unblocked', { player: 'youtube' });
    this.cb.onSoundBlocked?.(false);
  }

  isSoundBlocked() {
    return this.soundBlocked;
  }

  recover() {
    if (!this.player || !this.wantsPlay) return;
    const state = this.player.getPlayerState?.();
    if (state !== 1 && state !== 3) {
      diag('yt-restarted-after-background', { state });
      this.player.playVideo?.();
      this.scheduleProbe(1500);
    }
  }

  describe() {
    return {
      player: 'youtube',
      state: this.player?.getPlayerState?.() ?? null,
      muted: Boolean(this.player?.isMuted?.()),
      volume: this.player?.getVolume?.() ?? null,
      quality: this.player?.getPlaybackQuality?.() ?? null,
      loaded: Math.round((this.player?.getVideoLoadedFraction?.() ?? 0) * 100),
      soundBlocked: this.soundBlocked,
    };
  }

  getAudioInfo(): AudioInfo {
    return { muted: Boolean(this.player?.isMuted?.()), audioBytes: null, hasAudio: null };
  }
  seek(s: number) { this.player?.seekTo?.(s, true); }
  getTime() { return this.player?.getCurrentTime?.() ?? 0; }
  getDuration() { return this.player?.getDuration?.() ?? 0; }

  getBuffered() {
    // YouTube reports a fraction of the whole video rather than a time range.
    const fraction = this.player?.getVideoLoadedFraction?.() ?? 0;
    return fraction * this.getDuration();
  }

  setVolume(v: number) { this.player?.setVolume?.(Math.round(v * 100)); }
  setMuted(m: boolean) {
    // While the browser holds the sound back, only the unmute prompt may lift it.
    if (!m && this.soundBlocked) return;
    m ? this.player?.mute?.() : this.player?.unMute?.();
  }
  setRate(r: number) { this.player?.setPlaybackRate?.(r); }

  setQuality(id: string) {
    // YouTube treats this as a hint and may override it based on bandwidth.
    this.player?.setPlaybackQuality?.(id === 'auto' ? 'default' : id);
  }

  readonly supportsCaptions = true;

  setCaptions(enabled: boolean) {
    this.captionsWanted = enabled;
    this.applyCaptions();
  }

  /**
   * YouTube turns captions on by itself for some videos and accounts, and the
   * embed has no visible control for it, so the module is loaded or unloaded
   * outright rather than merely asked nicely.
   */
  private applyCaptions() {
    const player = this.player;
    if (!player) return;
    for (const module of ['captions', 'cc']) {
      try {
        if (this.captionsWanted) player.loadModule?.(module);
        else player.unloadModule?.(module);
      } catch {
        /* the module may not exist for this video */
      }
    }
  }

  private publishQualities() {
    if (!this.cb.onQualities) return;
    const levels: string[] = this.player?.getAvailableQualityLevels?.() ?? [];
    if (levels.length === 0) return;
    const options = [
      { id: 'auto', label: 'Auto' },
      ...levels.filter((l) => l !== 'auto').map((l) => ({ id: l, label: YT_QUALITY_LABELS[l] ?? l })),
    ];
    const active = this.player?.getPlaybackQuality?.();
    this.cb.onQualities(options, active && active !== 'auto' ? active : 'auto');
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    clearTimeout(this.autoplayProbe);
    document.removeEventListener('visibilitychange', this.onVisibility);
    try {
      this.player?.destroy?.();
    } catch {
      /* the iframe may already be gone */
    }
    this.player = null;
    this.mount.replaceChildren();
  }
}

/* ---------------------------------------------------------------- */
/* Vimeo                                                             */
/* ---------------------------------------------------------------- */

class VimeoAdapter implements Adapter {
  readonly kind = 'vimeo';
  readonly supportsRate = true;
  readonly supportsFineRate = true;
  readonly isLive = false;
  ready = false;

  private player: any = null;
  private destroyed = false;
  private time = 0;
  private duration = 0;
  private buffered = 0;

  constructor(
    private mount: HTMLElement,
    private videoId: string,
    private cb: AdapterCallbacks
  ) {
    void this.init();
  }

  private async init() {
    let Player: any;
    try {
      Player = (await import('@vimeo/player')).default;
    } catch {
      this.cb.onError('The Vimeo player could not be loaded');
      return;
    }
    if (this.destroyed) return;

    const host = document.createElement('div');
    host.style.width = '100%';
    host.style.height = '100%';
    this.mount.appendChild(host);

    this.player = new Player(host, {
      id: Number(this.videoId),
      controls: false,
      responsive: false,
      width: 1280,
      dnt: true,
      playsinline: true,
    });

    this.player.on('loaded', async () => {
      if (this.destroyed) return;
      this.ready = true;
      try {
        this.duration = await this.player.getDuration();
        if (this.duration > 0) this.cb.onDuration(this.duration);
      } catch {
        /* duration is optional */
      }
      this.cb.onReady();
    });
    this.player.on('timeupdate', (d: { seconds: number; duration: number }) => {
      this.time = d.seconds;
      this.duration = d.duration;
    });
    // Vimeo exposes real renditions, so this genuinely changes the stream.
    void this.player
      .getQualities?.()
      .then((qs: Array<{ id: string; label: string }>) => {
        if (this.destroyed || !this.cb.onQualities || !Array.isArray(qs)) return;
        const options = [
          { id: 'auto', label: 'Auto' },
          ...qs.filter((q) => q.id !== 'auto').map((q) => ({ id: q.id, label: q.label || q.id })),
        ];
        this.cb.onQualities(options, 'auto');
      })
      .catch(() => undefined);

    // Vimeo's "progress" is how much is downloaded, not how much is played.
    this.player.on('progress', (d: { seconds: number }) => {
      if (typeof d?.seconds === 'number') this.buffered = d.seconds;
    });
    this.player.on('bufferstart', () => this.cb.onBuffering(true));
    this.player.on('bufferend', () => this.cb.onBuffering(false));
    this.player.on('ended', () => this.cb.onEnded());
    this.player.on('error', () => this.cb.onError('Vimeo could not play this video'));
  }

  play() { this.player?.play?.().catch(() => undefined); }
  pause() { this.player?.pause?.().catch(() => undefined); }
  seek(s: number) { this.time = s; this.player?.setCurrentTime?.(s).catch(() => undefined); }
  getTime() { return this.time; }
  getDuration() { return this.duration; }
  getBuffered() { return this.buffered; }
  setVolume(v: number) { this.player?.setVolume?.(v).catch(() => undefined); }
  setMuted(m: boolean) { this.player?.setMuted?.(m).catch(() => undefined); }
  setRate(r: number) { this.player?.setPlaybackRate?.(r).catch(() => undefined); }
  setQuality(id: string) { this.player?.setQuality?.(id).catch(() => undefined); }

  readonly supportsCaptions = true;

  setCaptions(enabled: boolean) {
    if (!this.player) return;
    if (enabled) this.player.enableTextTrack?.('en').catch(() => undefined);
    else this.player.disableTextTrack?.().catch(() => undefined);
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    try {
      this.player?.destroy?.();
    } catch {
      /* ignore */
    }
    this.player = null;
    this.mount.replaceChildren();
  }
}

/* ---------------------------------------------------------------- */
/* Twitch                                                            */
/* ---------------------------------------------------------------- */

class TwitchAdapter implements Adapter {
  readonly kind = 'twitch';
  readonly supportsRate = false;
  readonly supportsFineRate = false;
  readonly isLive: boolean;
  ready = false;

  private player: any = null;
  private destroyed = false;
  private hostId: string;

  constructor(
    private mount: HTMLElement,
    private target: string,
    live: boolean,
    private cb: AdapterCallbacks
  ) {
    this.isLive = live;
    this.hostId = `twitch-${Math.random().toString(36).slice(2)}`;
    void this.init();
  }

  private async init() {
    try {
      await loadScript('https://player.twitch.tv/js/embed/v1.js');
    } catch {
      this.cb.onError('The Twitch player could not be loaded');
      return;
    }
    if (this.destroyed || !window.Twitch?.Player) return;

    const host = document.createElement('div');
    host.id = this.hostId;
    host.style.width = '100%';
    host.style.height = '100%';
    this.mount.appendChild(host);

    // Twitch refuses to embed unless the hosting domain is declared.
    const parents = Array.from(new Set([window.location.hostname, 'localhost'].filter(Boolean)));

    this.player = new window.Twitch.Player(this.hostId, {
      ...(this.isLive ? { channel: this.target } : { video: this.target }),
      width: '100%',
      height: '100%',
      autoplay: false,
      controls: false,
      muted: false,
      parent: parents,
    });

    const P = window.Twitch.Player;
    this.player.addEventListener(P.READY, () => {
      if (this.destroyed) return;
      this.ready = true;
      const d = this.player.getDuration?.();
      if (d > 0) this.cb.onDuration(d);
      this.cb.onReady();
      this.publishQualities();
    });
    this.player.addEventListener(P.ENDED, () => this.cb.onEnded());
    this.player.addEventListener(P.PLAYING, () => this.cb.onBuffering(false));
    this.player.addEventListener(P.OFFLINE, () => this.cb.onError('That Twitch channel is offline'));
  }

  play() { this.player?.play?.(); }
  pause() { if (!this.isLive) this.player?.pause?.(); }
  seek(s: number) { if (!this.isLive) this.player?.seek?.(s); }
  getTime() { return this.player?.getCurrentTime?.() ?? 0; }
  getDuration() { return this.player?.getDuration?.() ?? 0; }
  setVolume(v: number) { this.player?.setVolume?.(v); }
  setMuted(m: boolean) { this.player?.setMuted?.(m); }
  setRate() { /* Twitch has no playback rate API */ }

  setQuality(id: string) { this.player?.setQuality?.(id); }

  private publishQualities() {
    if (!this.cb.onQualities) return;
    const qs: Array<{ group: string; name: string }> = this.player?.getQualities?.() ?? [];
    if (qs.length === 0) return;
    const options = [
      { id: 'auto', label: 'Auto' },
      ...qs.filter((q) => q.group !== 'auto').map((q) => ({ id: q.group, label: q.name || q.group })),
    ];
    this.cb.onQualities(options, this.player?.getQuality?.() || 'auto');
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    this.player = null;
    this.mount.replaceChildren();
  }
}

/* ---------------------------------------------------------------- */
/* Dailymotion                                                       */
/* ---------------------------------------------------------------- */

/**
 * Driven through the embed player's postMessage API rather than its HLS
 * manifest: that manifest carries a token bound to the requesting address, so a
 * server-resolved URL is refused in the viewer's browser.
 */
class DailymotionAdapter implements Adapter {
  readonly kind = 'dailymotion';
  readonly supportsRate = false;
  readonly supportsFineRate = false;
  readonly isLive = false;
  ready = false;

  private frame: HTMLIFrameElement;
  private destroyed = false;
  private time = 0;
  private duration = 0;
  private muted = false;
  private volume = 1;
  private onMessage: (e: MessageEvent) => void;

  constructor(
    private mount: HTMLElement,
    videoId: string,
    private cb: AdapterCallbacks
  ) {
    const params = new URLSearchParams({
      api: 'postMessage',
      controls: 'false',
      queue_enable: 'false',
      sharing_enable: 'false',
      ui_logo: 'false',
      autoplay: 'false',
      origin: window.location.origin,
    });
    this.frame = document.createElement('iframe');
    this.frame.src = `https://www.dailymotion.com/embed/video/${encodeURIComponent(videoId)}?${params}`;
    this.frame.allow = 'autoplay; fullscreen; encrypted-media';
    this.frame.setAttribute('allowfullscreen', 'true');
    this.frame.style.border = '0';
    this.mount.appendChild(this.frame);

    this.onMessage = (event: MessageEvent) => {
      if (this.destroyed) return;
      if (!/dailymotion\.com$/.test(new URL(event.origin).hostname)) return;
      const data = typeof event.data === 'string' ? new URLSearchParams(event.data) : null;
      if (!data) return;
      const name = data.get('event');

      switch (name) {
        case 'apiready':
        case 'playback_ready':
          if (!this.ready) {
            this.ready = true;
            this.cb.onReady();
          }
          break;
        case 'timeupdate':
          this.time = Number(data.get('time')) || this.time;
          break;
        case 'durationchange':
          this.duration = Number(data.get('duration')) || this.duration;
          if (this.duration > 0) this.cb.onDuration(this.duration);
          break;
        case 'waiting':
          this.cb.onBuffering(true);
          break;
        case 'playing':
        case 'canplay':
        case 'pause':
          this.cb.onBuffering(false);
          break;
        case 'video_end':
        case 'ended':
          this.cb.onEnded();
          break;
        case 'error':
          this.cb.onError('Dailymotion could not play this video');
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', this.onMessage);
  }

  private send(command: string) {
    this.frame.contentWindow?.postMessage(command, '*');
  }

  play() { this.send('play'); }
  pause() { this.send('pause'); }
  seek(s: number) { this.time = s; this.send(`seek=${s}`); }
  getTime() { return this.time; }
  getDuration() { return this.duration; }
  setVolume(v: number) { this.volume = v; this.send(`volume=${this.muted ? 0 : v}`); }
  setMuted(m: boolean) { this.muted = m; this.send(`muted=${m ? 1 : 0}`); }
  setRate() { /* the embed API exposes no playback rate */ }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    window.removeEventListener('message', this.onMessage);
    this.mount.replaceChildren();
  }
}

/* ---------------------------------------------------------------- */
/* Direct files, HLS, uploads                                        */
/* ---------------------------------------------------------------- */

class HtmlAdapter implements Adapter {
  readonly kind = 'html';
  readonly supportsRate = true;
  readonly supportsFineRate = true;
  readonly isLive = false;
  ready = false;

  private video: HTMLVideoElement;
  private hls: any = null;
  private destroyed = false;
  private captionsWanted = false;
  /** Set by play() so a source arriving late still starts playing. */
  private wantsPlay = false;
  /** Muted by us because the browser refused sound, not by the viewer. */
  private soundBlocked = false;
  private reportedTrackProblem = false;
  /** Picture watchdog: decoded frames at the last check, and how long they stood still. */
  private frameCheck = { frames: -1, time: 0, stuckChecks: 0, repairedAt: 0, reported: false };
  private frameTimer: number | undefined;

  private src = '';

  constructor(
    private mount: HTMLElement,
    /** A promise lets the ARD resolver hand us a fresh CDN link. */
    private source: string | Promise<string>,
    private cb: AdapterCallbacks,
    private audioOnly = false
  ) {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.controls = false;
    // Deliberately no crossOrigin: plain playback never needs it, and asking
    // for CORS breaks every CDN that does not send the headers back.
    this.video.style.width = '100%';
    this.video.style.height = '100%';
    this.video.style.objectFit = 'contain';
    this.video.style.background = '#000';
    this.mount.appendChild(this.video);

    this.video.textTracks.addEventListener?.('addtrack', () => this.announceCaptions());
    this.video.addEventListener('loadedmetadata', () => {
      this.ready = true;
      this.announceCaptions();
      if (Number.isFinite(this.video.duration) && this.video.duration > 0) this.cb.onDuration(this.video.duration);
      this.cb.onReady();
      this.checkVideoTrack();
      // A pending play could not run while there was no source. Run it now.
      if (this.wantsPlay) this.play();
    });
    this.video.addEventListener('waiting', () => this.cb.onBuffering(true));
    this.video.addEventListener('stalled', () => this.cb.onBuffering(true));
    this.video.addEventListener('playing', () => {
      this.cb.onBuffering(false);
      this.checkVideoTrack();
    });
    this.video.addEventListener('canplay', () => this.cb.onBuffering(false));
    this.video.addEventListener('ended', () => this.cb.onEnded());
    this.video.addEventListener('error', () => this.reportMediaError());

    if (!audioOnly) this.frameTimer = window.setInterval(() => this.watchPicture(), 2000);
    void this.attach();
  }

  private decodedFrames(): number | null {
    const v = this.video as HTMLVideoElement & { webkitDecodedFrameCount?: number };
    const quality = v.getVideoPlaybackQuality?.();
    if (quality) return quality.totalVideoFrames;
    return typeof v.webkitDecodedFrameCount === 'number' ? v.webkitDecodedFrameCount : null;
  }

  /**
   * "Black picture, sound or subtitles carry on": the clock runs, but no new
   * frame has been decoded. Browsers switch the video track off for hidden
   * tabs and do not always bring it back cleanly. Only judged while visible -
   * in the background no frames is normal. A seek to where we already are
   * makes the decoder start over from the nearest keyframe.
   */
  private watchPicture() {
    const fc = this.frameCheck;
    if (this.destroyed || this.video.paused || this.video.readyState < 2 || !isVisible()) {
      fc.frames = -1;
      fc.stuckChecks = 0;
      return;
    }
    const frames = this.decodedFrames();
    if (frames == null) return;
    const time = this.video.currentTime;
    if (fc.frames >= 0 && time - fc.time > 1 && frames === fc.frames) {
      fc.stuckChecks += 1;
    } else if (fc.frames >= 0 && frames !== fc.frames) {
      if (fc.reported) diag('picture-back', { afterRepair: fc.repairedAt > 0 });
      fc.stuckChecks = 0;
      fc.reported = false;
    }
    fc.frames = frames;
    fc.time = time;

    if (fc.stuckChecks >= 2 && !fc.reported) {
      fc.reported = true;
      diag('picture-frozen', { ...this.describe(), frames }, 'warn');
    }
    if (fc.stuckChecks >= 2 && Date.now() - fc.repairedAt > 20000) {
      fc.repairedAt = Date.now();
      fc.stuckChecks = 0;
      diag('picture-repair', { at: Math.round(time) });
      try {
        this.video.currentTime = time;
      } catch {
        /* not seekable */
      }
    }
  }

  /**
   * The nastiest failure mode there is: the container and the audio track are
   * fine, so the browser happily plays sound, but it cannot decode the video
   * codec - and it fires no error at all. You get a black rectangle and no
   * explanation. HEVC/H.265 in an MP4 does exactly this in Edge without the
   * HEVC extension, and in Firefox always.
   */
  private checkVideoTrack() {
    if (this.destroyed || this.reportedTrackProblem) return;
    if (this.audioOnly) return;
    if (this.video.videoWidth > 0) return;
    // readyState >= HAVE_CURRENT_DATA means it has decoded something to show.
    if (this.video.readyState < 2) return;

    this.reportedTrackProblem = true;
    this.cb.onError(
      'This browser can play the sound but not the picture of this file - its video codec is not supported ' +
        '(H.265/HEVC is the usual culprit). Re-encode it as H.264 in an .mp4, or watch it in Chrome.'
    );
  }

  private reportMediaError() {
    const err = this.video.error;
    diag('player-error', { player: 'html5', code: err?.code ?? null, message: err?.message?.slice(0, 160) ?? null }, 'error');
    const detail: Record<number, string> = {
      1: 'Loading was aborted.',
      2: 'The network dropped while loading this file.',
      3: 'This file is damaged, or its codec cannot be decoded here.',
      4: 'This browser cannot play this file. Its format or codec is unsupported - ' +
        'MKV, MOV and H.265/HEVC often fail. An .mp4 with H.264 video and AAC audio plays everywhere.',
    };
    this.cb.onError(detail[err?.code ?? 0] || 'This video could not be played.');
  }

  private async attach() {
    try {
      this.src = typeof this.source === 'string' ? this.source : await this.source;
    } catch (err) {
      this.cb.onError(err instanceof Error ? err.message : 'Could not resolve that stream');
      return;
    }
    if (this.destroyed || !this.src) return;

    const isHls = /\.m3u8(\?|#|$)/i.test(this.src) || /\/i\/.*\.csmil/i.test(this.src);

    // Prefer hls.js wherever Media Source Extensions exist, even if the browser
    // claims native HLS: only hls.js exposes the rendition ladder, which is what
    // the resolution picker drives. iOS has no MSE for this and falls through to
    // the native player below.
    if (isHls) {
      try {
        const Hls = (await import('hls.js')).default;
        if (this.destroyed) return;
        if (Hls.isSupported()) {
          this.hls = new Hls({ enableWorker: true, lowLatencyMode: false });
          this.hls.loadSource(this.src);
          this.hls.attachMedia(this.video);
          // An HLS ladder is the one case where we can switch rendition properly.
          this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const levels: Array<{ height?: number; bitrate?: number }> = this.hls?.levels ?? [];
            if (!this.cb.onQualities || levels.length < 2) return;
            this.cb.onQualities(
              [
                { id: 'auto', label: 'Auto' },
                ...levels.map((l, i) => ({
                  id: String(i),
                  label: l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)} kbps`,
                })),
              ],
              'auto'
            );
          });
          this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.announceCaptions());
          this.hls.on(Hls.Events.ERROR, (_e: unknown, data: any) => {
            // Non-fatal ones (a segment retried) are routine; log only what matters.
            if (data?.fatal || data?.type === 'mediaError') {
              diag(
                'hls-error',
                { type: data?.type, details: data?.details, fatal: Boolean(data?.fatal), status: data?.response?.code ?? null },
                data?.fatal ? 'error' : 'warn'
              );
            }
            if (data?.fatal) this.cb.onError('The HLS stream stopped working');
          });
          return;
        }
      } catch {
        this.cb.onError('HLS playback is not available in this browser');
        return;
      }
    }
    this.video.src = this.src;
  }

  play() {
    this.wantsPlay = true;
    // Calling play() before attach() has set a source rejects, and nothing ever
    // retried it: the room said "playing" while this tab sat on a black frame
    // until you left and rejoined. Remember the intent and let attach run it.
    if (!this.video.currentSrc && !this.video.src) return;
    this.video
      .play()
      .then(() => {
        if (!this.soundBlocked) this.cb.onSoundBlocked?.(false);
      })
      .catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : 'Error';
        // Only NotAllowedError means "no sound without a click". AbortError -
        // a seek or a pause landing on top of play(), routine during sync - used
        // to be taken for it too and muted the viewer for nothing.
        if (name !== 'NotAllowedError' || this.video.muted) {
          if (name !== 'AbortError') diag('play-rejected', { player: 'html5', error: name }, 'warn');
          return;
        }
        // Sound was refused. Play muted so the picture stays in sync, but say so.
        this.video.muted = true;
        this.soundBlocked = true;
        diag('sound-blocked', { player: 'html5', hadGesture: hadGesture(), visible: isVisible() }, 'warn');
        this.video
          .play()
          .then(() => this.cb.onSoundBlocked?.(true))
          .catch(() => undefined);
      });
  }

  unmute() {
    this.soundBlocked = false;
    this.video.muted = false;
    this.cb.onSoundBlocked?.(false);
    this.video
      .play()
      .then(() => diag('sound-unblocked', { player: 'html5' }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          // Still not allowed (no click yet) - back to muted rather than paused.
          this.video.muted = true;
          this.soundBlocked = true;
          this.cb.onSoundBlocked?.(true);
          this.video.play().catch(() => undefined);
        }
      });
  }

  isSoundBlocked() {
    return this.soundBlocked;
  }

  recover() {
    if (this.destroyed || !this.wantsPlay) return;
    if (this.video.paused) {
      diag('html5-restarted-after-background', { readyState: this.video.readyState });
      this.play();
    }
    // Let the picture watchdog look again straight away.
    this.frameCheck.frames = -1;
    this.frameCheck.stuckChecks = 0;
  }

  describe() {
    return {
      player: 'html5',
      paused: this.video.paused,
      muted: this.video.muted,
      readyState: this.video.readyState,
      networkState: this.video.networkState,
      size: `${this.video.videoWidth}x${this.video.videoHeight}`,
      at: Math.round(this.video.currentTime),
      frames: this.decodedFrames(),
      hlsLevel: this.hls ? this.hls.currentLevel : null,
      soundBlocked: this.soundBlocked,
    };
  }

  getAudioInfo(): AudioInfo {
    const v = this.video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; mozHasAudio?: boolean };
    return {
      muted: v.muted,
      audioBytes: typeof v.webkitAudioDecodedByteCount === 'number' ? v.webkitAudioDecodedByteCount : null,
      hasAudio: typeof v.mozHasAudio === 'boolean' ? v.mozHasAudio : null,
    };
  }
  pause() { this.wantsPlay = false; this.video.pause(); }
  seek(s: number) { try { this.video.currentTime = s; } catch { /* not seekable yet */ } }
  getTime() { return this.video.currentTime || 0; }
  getDuration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }

  getBuffered() {
    const ranges = this.video.buffered;
    const at = this.video.currentTime || 0;
    // Only the range we are actually inside counts. A file seeked around in has
    // several islands of data, and the last one says nothing about the playhead.
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= at + 0.5 && ranges.end(i) >= at) return ranges.end(i);
    }
    return ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
  }
  setVolume(v: number) { this.video.volume = Math.max(0, Math.min(1, v)); }
  setMuted(m: boolean) { this.video.muted = m; }
  setRate(r: number) { this.video.playbackRate = r; }

  setQuality(id: string) {
    // Only an HLS ladder has renditions; a plain file is a single stream.
    if (!this.hls) return;
    this.hls.currentLevel = id === 'auto' ? -1 : Number(id);
  }

  readonly supportsCaptions = true;

  setCaptions(enabled: boolean) {
    this.captionsWanted = enabled;
    if (this.hls) this.hls.subtitleTrack = enabled ? Math.max(0, this.hls.subtitleTrack) : -1;
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = enabled && i === 0 ? 'showing' : 'disabled';
    }
  }

  private announceCaptions() {
    const hasHls = Boolean(this.hls?.subtitleTracks?.length);
    this.cb.onCaptionsAvailable?.(hasHls || this.video.textTracks.length > 0);
    // Default to off, matching every other player in the app.
    if (!this.captionsWanted) this.setCaptions(false);
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    window.clearInterval(this.frameTimer);
    try {
      this.hls?.destroy?.();
    } catch {
      /* ignore */
    }
    this.video.removeAttribute('src');
    this.video.load();
    this.mount.replaceChildren();
  }
}

/* ---------------------------------------------------------------- */
/* Factory                                                           */
/* ---------------------------------------------------------------- */

/** Sources whose CDN links are signed and must be fetched again at play time. */
const FRESH_STREAM_SOURCES = new Set(['ard', 'zdf', 'arte', 'srg', 'peertube', 'archive']);

async function resolveStream(provider: string, id: string): Promise<string> {
  const res = await fetch(`/api/media/stream/${provider}/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) throw new Error(data?.error || 'That stream could not be loaded');
  return data.url as string;
}

/** Music uploads have no picture by design, so never warn about a missing one. */
const AUDIO_ONLY = /\.(mp3|m4a|flac|wav|ogg|oga|aac|opus)(\?|#|$)/i;

export function createAdapter(mount: HTMLElement, item: QueueItem, cb: AdapterCallbacks): Adapter {
  const audioOnly = AUDIO_ONLY.test(item.title || '') || AUDIO_ONLY.test(item.url || '');
  switch (item.source) {
    case 'youtube':
      return new YouTubeAdapter(mount, item.sourceId, cb);
    case 'vimeo':
      return new VimeoAdapter(mount, item.sourceId, cb);
    case 'twitch':
      return new TwitchAdapter(mount, item.sourceId, false, cb);
    case 'twitch_live':
      return new TwitchAdapter(mount, item.sourceId, true, cb);
    case 'upload':
      return new HtmlAdapter(mount, item.url || `/api/uploads/${item.sourceId}/file`, cb, audioOnly);
    case 'dailymotion':
      return new DailymotionAdapter(mount, item.sourceId, cb);
    default:
      // Mediatheken and PeerTube resolve to a fresh signed URL on every play.
      if (FRESH_STREAM_SOURCES.has(item.source)) {
        return new HtmlAdapter(mount, resolveStream(item.source, item.sourceId), cb, audioOnly);
      }
      return new HtmlAdapter(mount, item.url || item.sourceId, cb, audioOnly);
  }
}
