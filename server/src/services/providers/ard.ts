import { MediaError, getJson, hostMatches, type Provider, type ResolvedStream } from './types';
import type { MediaItem } from '../../types';

/**
 * ARD Mediathek, which also fronts BR, WDR, NDR, MDR, SWR, hr and rbb.
 * The page-gateway API is public and its CDN answers with CORS headers, so
 * playback goes browser-to-CDN. The signed paths expire, hence freshStream.
 */

const GATEWAY = 'https://api.ardmediathek.de/page-gateway/pages/ard/item';

interface ArdStream {
  url: string;
  mimeType: string;
  height: number | null;
}

async function fetchItem(id: string): Promise<{ widget: any; streams: ArdStream[] }> {
  const data = await getJson(`${GATEWAY}/${encodeURIComponent(id)}?embedded=false&mcV6=true`);
  const widget = (data?.widgets ?? []).find((w: any) => w?.mediaCollection) ?? data?.widgets?.[0] ?? {};
  const embedded = widget?.mediaCollection?.embedded ?? {};

  const streams: ArdStream[] = [];
  for (const group of embedded?.streams ?? []) {
    // "main" is the programme itself; the rest are audio description etc.
    if (group?.kind && group.kind !== 'main') continue;
    for (const media of group?.media ?? []) {
      if (typeof media?.url !== 'string' || !media.url.startsWith('https://')) continue;
      streams.push({
        url: media.url,
        mimeType: media.mimeType ?? '',
        height: typeof media.maxHResolutionPx === 'number' ? media.maxHResolutionPx : null,
      });
    }
  }
  return { widget, streams };
}

export const ardProvider: Provider = {
  id: 'ard',
  label: 'ARD Mediathek',
  example: 'ardmediathek.de/video/...',

  match(url) {
    if (!hostMatches(url, 'ardmediathek.de')) return null;
    const last = url.pathname.split('/').filter(Boolean).pop();
    return last && /^[A-Za-z0-9_-]{20,}$/.test(last) ? last : null;
  },

  async resolve(id): Promise<MediaItem> {
    const { widget, streams } = await fetchItem(id);
    if (streams.length === 0) {
      throw new MediaError(
        widget?.geoblocked
          ? 'That programme is geo-blocked and cannot be played from here'
          : 'That ARD Mediathek page has no playable stream (it may be DRM protected or expired)'
      );
    }
    const meta = widget?.mediaCollection?.embedded?.meta ?? {};
    const show = widget?.show?.title ?? null;
    const episode = widget?.title ?? meta?.title ?? 'ARD Mediathek';

    return {
      source: 'ard',
      sourceId: id,
      url: null,
      title: show && !String(episode).startsWith(show) ? `${show} – ${episode}` : String(episode),
      author: show,
      duration: typeof meta?.durationSeconds === 'number' ? meta.durationSeconds : null,
      thumbnail: (meta?.images ?? [])[0]?.url?.replace('{width}', '960') ?? null,
    };
  },

  freshStream: async (id): Promise<ResolvedStream> => {
    const { streams } = await fetchItem(id);
    if (streams.length === 0) throw new MediaError('That programme is no longer available');
    // Adaptive HLS first so the resolution picker has a ladder to offer.
    const hls = streams.find((s) => /mpegurl/i.test(s.mimeType));
    if (hls) return { url: hls.url, mimeType: 'application/vnd.apple.mpegurl' };
    const best = streams
      .filter((s) => /mp4/i.test(s.mimeType))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
    return { url: (best ?? streams[0]).url, mimeType: 'video/mp4' };
  },
};
