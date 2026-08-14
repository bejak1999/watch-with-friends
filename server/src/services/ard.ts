import { MediaError } from './media';

/**
 * ARD Mediathek (and the ZDF-style page gateway the ARD apps use).
 *
 * The public page-gateway API hands out plain HLS and MP4 renditions, so
 * playback needs no proxy - the browser fetches the CDN directly and both
 * respond with CORS headers. Streams are resolved again at play time because
 * the CDN paths are signed and would otherwise go stale in a saved playlist.
 */

const GATEWAY = 'https://api.ardmediathek.de/page-gateway/pages/ard/item';

export interface ArdStream {
  url: string;
  mimeType: string;
  height: number | null;
}

export interface ArdItem {
  id: string;
  title: string;
  show: string | null;
  duration: number | null;
  thumbnail: string | null;
  streams: ArdStream[];
}

/** Accepts a full mediathek URL or the bare base64 id from it. */
export function parseArdId(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed) && !trimmed.includes('/')) return trimmed;

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (!/(^|\.)ardmediathek\.de$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    // .../video/<show-slug>/<episode-slug>/<channel>/<id>  or  .../video/<id>
    const last = parts[parts.length - 1];
    if (last && /^[A-Za-z0-9_-]{20,}$/.test(last)) return last;
    return null;
  } catch {
    return null;
  }
}

async function fetchGateway(id: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${GATEWAY}/${encodeURIComponent(id)}?embedded=false&mcV6=true`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) throw new MediaError('That ARD Mediathek page does not exist any more');
    if (!res.ok) throw new MediaError(`ARD Mediathek replied with HTTP ${res.status}`, 502);
    return await res.json();
  } catch (err) {
    if (err instanceof MediaError) throw err;
    throw new MediaError('Could not reach the ARD Mediathek', 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveArdItem(id: string): Promise<ArdItem> {
  const data = await fetchGateway(id);
  const widget = (data?.widgets ?? []).find((w: any) => w?.mediaCollection) ?? data?.widgets?.[0] ?? {};
  const embedded = widget?.mediaCollection?.embedded ?? {};
  const meta = embedded?.meta ?? {};

  const streams: ArdStream[] = [];
  for (const group of embedded?.streams ?? []) {
    // "main" is the programme; other kinds are audio description or sign language.
    if (group?.kind && group.kind !== 'main') continue;
    for (const media of group?.media ?? []) {
      const url = media?.url;
      const mimeType = media?.mimeType ?? '';
      if (typeof url !== 'string' || !url.startsWith('https://')) continue;
      streams.push({
        url,
        mimeType,
        height: typeof media?.maxHResolutionPx === 'number' ? media.maxHResolutionPx : null,
      });
    }
  }

  if (streams.length === 0) {
    const blocked = embedded?.isGeoblocked || widget?.geoblocked;
    throw new MediaError(
      blocked
        ? 'That programme is geo-blocked and cannot be played from this server'
        : 'That ARD Mediathek page has no playable stream (it may be DRM protected or expired)'
    );
  }

  const show = widget?.show?.title ?? null;
  const episode = widget?.title ?? meta?.title ?? 'ARD Mediathek';

  return {
    id,
    title: show && !String(episode).startsWith(show) ? `${show} – ${episode}` : String(episode),
    show,
    duration: typeof meta?.durationSeconds === 'number' ? meta.durationSeconds : null,
    thumbnail: (meta?.images ?? [])[0]?.url?.replace('{width}', '960') ?? null,
    streams,
  };
}

/**
 * Adaptive HLS first: it carries every rendition, so the viewer's own
 * resolution picker works. A progressive MP4 is the fallback.
 */
export function pickBestStream(streams: ArdStream[]): ArdStream {
  const hls = streams.find((s) => /mpegurl/i.test(s.mimeType));
  if (hls) return hls;
  const mp4s = streams
    .filter((s) => /mp4/i.test(s.mimeType))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return mp4s[0] ?? streams[0];
}
