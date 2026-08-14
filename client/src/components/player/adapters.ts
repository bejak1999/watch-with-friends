import type { QueueItem } from '../../lib/api';

export interface QualityOption {
  id: string;
  label: string;
}

export interface AdapterCallbacks {
  /** Fired once the player knows which resolutions it can offer. */
  onQualities?: (options: QualityOption[], activeId: string) => void;
  onReady: () => void;
  onEnded: () => void;
  onBuffering: (buffering: boolean) => void;
  onDuration: (seconds: number) => void;
  /** Fired when the embedded player changed state on its own (user clicked it). */
  onLocalIntent?: (intent: 'play' | 'pause') => void;
  onError: (message: string) => void;
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
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setRate(rate: number): void;
  /** Resolution is a per-viewer choice, never synced - bandwidth differs. */
  setQuality?(id: string): void;
  destroy(): void;
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

  constructor(
    private mount: HTMLElement,
    private videoId: string,
    private cb: AdapterCallbacks
  ) {
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
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          if (this.destroyed) return;
          this.ready = true;
          const d = this.player.getDuration?.();
          if (d > 0) this.cb.onDuration(d);
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
          }
          this.lastState = e.data;
        },
        onError: (e: { data: number }) => {
          const messages: Record<number, string> = {
            2: 'That YouTube video id is invalid',
            5: 'YouTube cannot play this video in an embedded player',
            100: 'That YouTube video was removed or is private',
            101: 'The uploader does not allow this video to be embedded',
            150: 'The uploader does not allow this video to be embedded',
          };
          this.cb.onError(messages[e.data] || 'YouTube could not play this video');
        },
      },
    });
  }

  play() { this.player?.playVideo?.(); }
  pause() { this.player?.pauseVideo?.(); }
  seek(s: number) { this.player?.seekTo?.(s, true); }
  getTime() { return this.player?.getCurrentTime?.() ?? 0; }
  getDuration() { return this.player?.getDuration?.() ?? 0; }
  setVolume(v: number) { this.player?.setVolume?.(Math.round(v * 100)); }
  setMuted(m: boolean) { m ? this.player?.mute?.() : this.player?.unMute?.(); }
  setRate(r: number) { this.player?.setPlaybackRate?.(r); }

  setQuality(id: string) {
    // YouTube treats this as a hint and may override it based on bandwidth.
    this.player?.setPlaybackQuality?.(id === 'auto' ? 'default' : id);
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
  setVolume(v: number) { this.player?.setVolume?.(v).catch(() => undefined); }
  setMuted(m: boolean) { this.player?.setMuted?.(m).catch(() => undefined); }
  setRate(r: number) { this.player?.setPlaybackRate?.(r).catch(() => undefined); }
  setQuality(id: string) { this.player?.setQuality?.(id).catch(() => undefined); }

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

  private src = '';

  constructor(
    private mount: HTMLElement,
    /** A promise lets the ARD resolver hand us a fresh CDN link. */
    private source: string | Promise<string>,
    private cb: AdapterCallbacks
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

    this.video.addEventListener('loadedmetadata', () => {
      this.ready = true;
      if (Number.isFinite(this.video.duration) && this.video.duration > 0) this.cb.onDuration(this.video.duration);
      this.cb.onReady();
    });
    this.video.addEventListener('waiting', () => this.cb.onBuffering(true));
    this.video.addEventListener('stalled', () => this.cb.onBuffering(true));
    this.video.addEventListener('playing', () => this.cb.onBuffering(false));
    this.video.addEventListener('canplay', () => this.cb.onBuffering(false));
    this.video.addEventListener('ended', () => this.cb.onEnded());
    this.video.addEventListener('error', () => {
      this.cb.onError('This video could not be played. The link may be broken or blocked by CORS.');
    });

    void this.attach();
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
          this.hls.on(Hls.Events.ERROR, (_e: unknown, data: any) => {
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
    this.video.play().catch(() => {
      // Autoplay was refused; a muted retry keeps the room in sync visually.
      this.video.muted = true;
      this.video.play().catch(() => undefined);
    });
  }
  pause() { this.video.pause(); }
  seek(s: number) { try { this.video.currentTime = s; } catch { /* not seekable yet */ } }
  getTime() { return this.video.currentTime || 0; }
  getDuration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }
  setVolume(v: number) { this.video.volume = Math.max(0, Math.min(1, v)); }
  setMuted(m: boolean) { this.video.muted = m; }
  setRate(r: number) { this.video.playbackRate = r; }

  setQuality(id: string) {
    // Only an HLS ladder has renditions; a plain file is a single stream.
    if (!this.hls) return;
    this.hls.currentLevel = id === 'auto' ? -1 : Number(id);
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
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

export function createAdapter(mount: HTMLElement, item: QueueItem, cb: AdapterCallbacks): Adapter {
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
      return new HtmlAdapter(mount, item.url || `/api/uploads/${item.sourceId}/file`, cb);
    case 'dailymotion':
      return new DailymotionAdapter(mount, item.sourceId, cb);
    default:
      // Mediatheken and PeerTube resolve to a fresh signed URL on every play.
      if (FRESH_STREAM_SOURCES.has(item.source)) {
        return new HtmlAdapter(mount, resolveStream(item.source, item.sourceId), cb);
      }
      return new HtmlAdapter(mount, item.url || item.sourceId, cb);
  }
}
