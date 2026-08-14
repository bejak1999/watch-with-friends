import { config } from '../config';
import { getSetting } from '../db';
import type { MediaItem } from '../types';

export function youtubeApiKey(): string {
  return getSetting('youtube_api_key') || config.youtubeApiKeyEnv;
}

export class MediaError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* URL parsing                                                         */
/* ------------------------------------------------------------------ */

export interface ParsedUrl {
  kind: 'youtube_video' | 'youtube_playlist' | 'vimeo' | 'twitch_vod' | 'twitch_channel' | 'direct' | 'unknown';
  id: string;
  /** Present when a YouTube watch URL also carries a ?list= parameter. */
  playlistId?: string;
  startSeconds?: number;
  url: string;
}

const DIRECT_EXTENSIONS = /\.(mp4|webm|ogv|ogg|m4v|mov|mkv|m3u8|mpd|mp3|m4a|flac|wav|aac)(\?|#|$)/i;

export function parseMediaUrl(raw: string): ParsedUrl {
  const trimmed = raw.trim();

  // A bare 11-character YouTube id is a common paste.
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return { kind: 'youtube_video', id: trimmed, url: `https://www.youtube.com/watch?v=${trimmed}` };
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return { kind: 'unknown', id: '', url: trimmed };
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  const startSeconds = parseTimestamp(url.searchParams.get('t') || url.hash.replace('#t=', ''));

  // ---- YouTube ----
  if (host === 'youtu.be') {
    const id = parts[0] || '';
    return { kind: 'youtube_video', id, url: trimmed, startSeconds, playlistId: cleanList(url.searchParams.get('list')) };
  }
  if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('youtube-nocookie.com')) {
    const list = cleanList(url.searchParams.get('list'));
    const v = url.searchParams.get('v');
    if (v) return { kind: 'youtube_video', id: v, url: trimmed, startSeconds, playlistId: list };
    if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live' || parts[0] === 'v') {
      return { kind: 'youtube_video', id: parts[1] || '', url: trimmed, startSeconds, playlistId: list };
    }
    if (parts[0] === 'playlist' && list) return { kind: 'youtube_playlist', id: list, url: trimmed };
    if (list) return { kind: 'youtube_playlist', id: list, url: trimmed };
  }

  // ---- Vimeo ----
  if (host.endsWith('vimeo.com')) {
    const numeric = parts.find((p) => /^\d+$/.test(p));
    if (numeric) return { kind: 'vimeo', id: numeric, url: trimmed, startSeconds };
  }

  // ---- Twitch ----
  if (host.endsWith('twitch.tv')) {
    if (parts[0] === 'videos' && parts[1]) return { kind: 'twitch_vod', id: parts[1], url: trimmed, startSeconds };
    if (parts[1] === 'v' && parts[2]) return { kind: 'twitch_vod', id: parts[2], url: trimmed, startSeconds };
    if (parts[0] && !['directory', 'settings', 'downloads', 'p'].includes(parts[0])) {
      return { kind: 'twitch_channel', id: parts[0], url: trimmed, startSeconds };
    }
  }

  // ---- Anything that looks like a playable file / stream ----
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'direct', id: url.toString(), url: url.toString(), startSeconds };
  }

  return { kind: 'unknown', id: '', url: trimmed };
}

/** YouTube "mix"/radio lists (RD…) are generated per-viewer and cannot be imported. */
function cleanList(list: string | null): string | undefined {
  if (!list) return undefined;
  if (/^(RD|UL|TL)/.test(list)) return undefined;
  return list;
}

function parseTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return undefined;
  const [, h, mi, s] = m;
  const total = (parseInt(h || '0', 10) * 3600) + (parseInt(mi || '0', 10) * 60) + parseInt(s || '0', 10);
  return total > 0 ? total : undefined;
}

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const reason = json?.error?.message || `HTTP ${res.status}`;
      throw new MediaError(reason, res.status === 403 ? 502 : 400);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (
    parseInt(d || '0', 10) * 86400 +
    parseInt(h || '0', 10) * 3600 +
    parseInt(mi || '0', 10) * 60 +
    parseFloat(s || '0')
  );
}

function bestThumb(thumbs: any): string | null {
  if (!thumbs) return null;
  return (
    thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || null
  );
}

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

async function youtubeVideos(ids: string[]): Promise<Map<string, MediaItem>> {
  const key = youtubeApiKey();
  const out = new Map<string, MediaItem>();
  if (!key || ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status` +
      `&id=${chunk.join(',')}&key=${encodeURIComponent(key)}`;
    const data = await fetchJson(url);
    for (const item of data?.items || []) {
      out.set(item.id, {
        source: 'youtube',
        sourceId: item.id,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        title: item.snippet?.title || item.id,
        author: item.snippet?.channelTitle || null,
        duration: parseIsoDuration(item.contentDetails?.duration),
        thumbnail: bestThumb(item.snippet?.thumbnails),
      });
    }
  }
  return out;
}

/** Works without an API key; gives us a title but no duration. */
async function youtubeOembed(id: string): Promise<MediaItem> {
  try {
    const data = await fetchJson(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`
    );
    return {
      source: 'youtube',
      sourceId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: data?.title || `YouTube video ${id}`,
      author: data?.author_name || null,
      duration: null,
      thumbnail: data?.thumbnail_url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  } catch {
    return {
      source: 'youtube',
      sourceId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: `YouTube video ${id}`,
      duration: null,
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
}

export async function resolveYoutubeVideo(id: string): Promise<MediaItem> {
  if (youtubeApiKey()) {
    const map = await youtubeVideos([id]);
    const hit = map.get(id);
    if (hit) return hit;
  }
  return youtubeOembed(id);
}

export async function resolveYoutubePlaylist(
  playlistId: string,
  maxItems = 300
): Promise<{ title: string; items: MediaItem[] }> {
  const key = youtubeApiKey();
  if (!key) {
    throw new MediaError(
      'Importing playlists needs a YouTube API key. An admin can add one under Admin → Integrations.',
      400
    );
  }

  let title = 'YouTube playlist';
  try {
    const meta = await fetchJson(
      `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(key)}`
    );
    if (meta?.items?.[0]?.snippet?.title) title = meta.items[0].snippet.title;
  } catch {
    /* the playlist may be unlisted-but-accessible; keep the fallback title */
  }

  const items: MediaItem[] = [];
  let pageToken = '';
  while (items.length < maxItems) {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50` +
      `&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(key)}` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await fetchJson(url);
    const pageIds: string[] = [];
    const partial: MediaItem[] = [];
    for (const it of data?.items || []) {
      const vid = it.contentDetails?.videoId;
      const snip = it.snippet;
      if (!vid) continue;
      // Deleted/private entries carry these placeholder titles and cannot be played.
      if (snip?.title === 'Deleted video' || snip?.title === 'Private video') continue;
      pageIds.push(vid);
      partial.push({
        source: 'youtube',
        sourceId: vid,
        url: `https://www.youtube.com/watch?v=${vid}`,
        title: snip?.title || vid,
        author: snip?.videoOwnerChannelTitle || snip?.channelTitle || null,
        duration: null,
        thumbnail: bestThumb(snip?.thumbnails),
      });
    }

    // Second call fills in durations, which playlistItems does not return.
    const details = await youtubeVideos(pageIds);
    for (const item of partial) {
      const d = details.get(item.sourceId);
      if (d) {
        item.duration = d.duration;
        item.thumbnail = item.thumbnail || d.thumbnail;
        item.author = item.author || d.author;
      }
      items.push(item);
      if (items.length >= maxItems) break;
    }

    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
  }

  if (items.length === 0) throw new MediaError('That playlist is empty or not public', 400);
  return { title, items };
}

export async function searchYoutube(query: string, limit = 24): Promise<MediaItem[]> {
  const key = youtubeApiKey();
  if (!key) throw new MediaError('YouTube search needs an API key. Ask an admin to add one.', 400);

  const data = await fetchJson(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${limit}` +
      `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`
  );
  const ids: string[] = (data?.items || []).map((i: any) => i.id?.videoId).filter(Boolean);
  const details = await youtubeVideos(ids);
  return ids.map((id) => details.get(id)).filter((x): x is MediaItem => Boolean(x));
}

/* ------------------------------------------------------------------ */
/* Vimeo / Twitch / direct                                             */
/* ------------------------------------------------------------------ */

export async function resolveVimeo(id: string): Promise<MediaItem> {
  try {
    const data = await fetchJson(
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`
    );
    return {
      source: 'vimeo',
      sourceId: id,
      url: `https://vimeo.com/${id}`,
      title: data?.title || `Vimeo ${id}`,
      author: data?.author_name || null,
      duration: typeof data?.duration === 'number' ? data.duration : null,
      thumbnail: data?.thumbnail_url || null,
    };
  } catch {
    throw new MediaError('That Vimeo video could not be loaded (it may be private or password protected)');
  }
}

export function resolveTwitchVod(id: string): MediaItem {
  return {
    source: 'twitch',
    sourceId: id,
    url: `https://www.twitch.tv/videos/${id}`,
    title: `Twitch VOD ${id}`,
    author: null,
    duration: null,
    thumbnail: null,
  };
}

export function resolveTwitchChannel(channel: string): MediaItem {
  return {
    source: 'twitch_live',
    sourceId: channel,
    url: `https://www.twitch.tv/${channel}`,
    title: `${channel} (live)`,
    author: channel,
    duration: null,
    thumbnail: null,
  };
}

export async function resolveDirect(rawUrl: string): Promise<MediaItem> {
  const url = new URL(rawUrl);
  const filename = decodeURIComponent(url.pathname.split('/').pop() || 'Video');
  let title = filename.replace(/\.[a-z0-9]{2,5}$/i, '') || url.hostname;
  let looksPlayable = DIRECT_EXTENSIONS.test(url.pathname);

  if (!looksPlayable) {
    // A HEAD probe keeps us from queueing an HTML page as if it were a video.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(rawUrl, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      const type = res.headers.get('content-type') || '';
      if (/^(video|audio)\//i.test(type) || /mpegurl|dash\+xml/i.test(type)) looksPlayable = true;
    } catch {
      /* CORS or no HEAD support - fall through to the error below */
    }
  }

  if (!looksPlayable) {
    throw new MediaError(
      'That link is not a recognised video. Supported: YouTube, Vimeo, Twitch, or a direct .mp4/.webm/.m3u8 URL.'
    );
  }

  return {
    source: 'direct',
    sourceId: rawUrl,
    url: rawUrl,
    title,
    author: url.hostname,
    duration: null,
    thumbnail: null,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export interface ResolveResult {
  items: MediaItem[];
  /** Set when the result came from a playlist import. */
  playlistTitle?: string;
  /** Set when a single video URL also referenced an importable playlist. */
  suggestedPlaylistId?: string;
}

export async function resolveMediaUrl(raw: string, mode: 'auto' | 'playlist' | 'single' = 'auto'): Promise<ResolveResult> {
  const parsed = parseMediaUrl(raw);

  switch (parsed.kind) {
    case 'youtube_video': {
      if (mode === 'playlist' && parsed.playlistId) {
        const pl = await resolveYoutubePlaylist(parsed.playlistId);
        return { items: pl.items, playlistTitle: pl.title };
      }
      if (!parsed.id) throw new MediaError('Could not read a video id from that link');
      const item = await resolveYoutubeVideo(parsed.id);
      return { items: [item], suggestedPlaylistId: parsed.playlistId };
    }
    case 'youtube_playlist': {
      if (mode === 'single') throw new MediaError('That link points at a playlist, not a single video');
      const pl = await resolveYoutubePlaylist(parsed.id);
      return { items: pl.items, playlistTitle: pl.title };
    }
    case 'vimeo':
      return { items: [await resolveVimeo(parsed.id)] };
    case 'twitch_vod':
      return { items: [resolveTwitchVod(parsed.id)] };
    case 'twitch_channel':
      return { items: [resolveTwitchChannel(parsed.id)] };
    case 'direct':
      return { items: [await resolveDirect(parsed.url)] };
    default:
      throw new MediaError('That does not look like a link we can play');
  }
}
