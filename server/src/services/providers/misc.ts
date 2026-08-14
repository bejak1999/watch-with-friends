import { MediaError, getJson, hostMatches, type Provider, type ResolvedStream } from './types';
import type { MediaItem } from '../../types';

/* ------------------------------------------------------------------ */
/* PeerTube - works against any instance                               */
/* ------------------------------------------------------------------ */

/**
 * PeerTube is federated, so the instance is part of the id. Its API is
 * identical everywhere and serves CORS headers, so one provider covers the
 * whole network.
 */
export const peertubeProvider: Provider = {
  id: 'peertube',
  label: 'PeerTube',
  example: 'any PeerTube instance',

  match(url) {
    // /w/<uuid>, /videos/watch/<uuid>, /w/p/<playlist> is not supported.
    const parts = url.pathname.split('/').filter(Boolean);
    const uuid = parts.find((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p));
    const short = parts[0] === 'w' && parts[1] && /^[A-Za-z0-9]{8,}$/.test(parts[1]) ? parts[1] : null;
    const id = uuid ?? short;
    if (!id) return null;
    if (!(parts.includes('w') || parts.includes('videos'))) return null;
    return `${url.host}/${id}`;
  },

  async resolve(id): Promise<MediaItem> {
    const [host, videoId] = [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)];
    const v = await getJson(`https://${host}/api/v1/videos/${encodeURIComponent(videoId)}`);
    if (!v?.uuid) throw new MediaError('That PeerTube video could not be found');
    return {
      source: 'peertube',
      sourceId: id,
      url: null,
      title: v.name || 'PeerTube video',
      author: v.account?.displayName ?? v.channel?.displayName ?? host,
      duration: typeof v.duration === 'number' ? v.duration : null,
      thumbnail: v.thumbnailPath ? `https://${host}${v.thumbnailPath}` : null,
    };
  },

  freshStream: async (id): Promise<ResolvedStream> => {
    const [host, videoId] = [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)];
    const v = await getJson(`https://${host}/api/v1/videos/${encodeURIComponent(videoId)}`);

    const hls = (v.streamingPlaylists ?? [])[0]?.playlistUrl;
    if (hls) return { url: hls, mimeType: 'application/vnd.apple.mpegurl' };

    const files = [...(v.files ?? [])].sort((a: any, b: any) => (b.resolution?.id ?? 0) - (a.resolution?.id ?? 0));
    const file = files.find((f: any) => f.fileUrl);
    if (!file) throw new MediaError('That PeerTube video has no downloadable stream');
    return { url: file.fileUrl, mimeType: 'video/mp4' };
  },
};

/* ------------------------------------------------------------------ */
/* Internet Archive                                                     */
/* ------------------------------------------------------------------ */

export const archiveProvider: Provider = {
  id: 'archive',
  label: 'Internet Archive',
  example: 'archive.org/details/...',

  match(url) {
    if (!hostMatches(url, 'archive.org')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'details' && parts[0] !== 'download') return null;
    return parts[1] ?? null;
  },

  async resolve(id): Promise<MediaItem> {
    const data = await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    if (!data?.metadata) throw new MediaError('That Internet Archive item does not exist');
    const playable = pickArchiveFile(data);
    if (!playable) throw new MediaError('That Internet Archive item has no playable video or audio file');

    return {
      source: 'archive',
      sourceId: id,
      url: null,
      title: String(data.metadata.title ?? id),
      author: data.metadata.creator ? String(data.metadata.creator) : 'Internet Archive',
      duration: playable.length ? Math.round(parseArchiveLength(playable.length)) : null,
      thumbnail: `https://archive.org/services/img/${encodeURIComponent(id)}`,
    };
  },

  freshStream: async (id): Promise<ResolvedStream> => {
    const data = await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    const file = pickArchiveFile(data);
    if (!file) throw new MediaError('That item has no playable file');
    return {
      url: `https://archive.org/download/${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      mimeType: /\.mp3$|\.flac$|\.ogg$/i.test(file.name) ? 'audio/mpeg' : 'video/mp4',
    };
  },
};

/** Browser-friendly formats only, biggest first so quality wins. */
function pickArchiveFile(data: any): any | null {
  const files: any[] = data?.files ?? [];
  const ranked = files
    .filter((f) => /\.(mp4|m4v|webm|ogv|mp3|m4a)$/i.test(f.name ?? ''))
    .sort((a, b) => {
      const rank = (n: string) => (/\.mp4$|\.m4v$/i.test(n) ? 3 : /\.webm$/i.test(n) ? 2 : 1);
      const byType = rank(b.name) - rank(a.name);
      return byType !== 0 ? byType : Number(b.size ?? 0) - Number(a.size ?? 0);
    });
  return ranked[0] ?? null;
}

/** Archive lengths are either seconds or "HH:MM:SS". */
function parseArchiveLength(value: string): number {
  if (/^\d+(\.\d+)?$/.test(value)) return parseFloat(value);
  const parts = value.split(':').map(Number);
  return parts.reduce((acc, part) => acc * 60 + (Number.isFinite(part) ? part : 0), 0);
}

/* ------------------------------------------------------------------ */
/* SRF / SRG - Swiss public broadcasting                                */
/* ------------------------------------------------------------------ */

const SRG_BUS: Record<string, string> = {
  'srf.ch': 'srf',
  'rts.ch': 'rts',
  'rsi.ch': 'rsi',
  'rtr.ch': 'rtr',
  'swissinfo.ch': 'swi',
};

export const srgProvider: Provider = {
  id: 'srg',
  label: 'SRF / RTS / RSI',
  example: 'srf.ch/play/tv/...',

  match(url) {
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const bu = Object.entries(SRG_BUS).find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1];
    if (!bu) return null;
    // .../play/tv/<show>/video/<slug>?urn=urn:srf:video:<id>
    const urn = url.searchParams.get('urn');
    if (urn) return `${bu}/${urn.split(':').pop()}`;
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('video');
    const id = idx >= 0 ? parts[idx + 1] : undefined;
    if (!id || !/^[0-9a-f-]{8,}$/i.test(id)) return null;
    return `${bu}/${id}`;
  },

  async resolve(id): Promise<MediaItem> {
    const { bu, media } = await srgComposition(id);
    return {
      source: 'srg',
      sourceId: id,
      url: null,
      title: media.title ?? 'SRG',
      author: bu.toUpperCase(),
      duration: typeof media.duration === 'number' ? Math.round(media.duration / 1000) : null,
      thumbnail: media.imageUrl ?? null,
    };
  },

  freshStream: async (id): Promise<ResolvedStream> => {
    const { resources } = await srgComposition(id);
    const hls = resources.find((r: any) => /HLS/i.test(r.streaming));
    const chosen = hls ?? resources[0];
    if (!chosen) throw new MediaError('That programme has no playable stream');
    if (chosen.drmList) throw new MediaError('That programme is DRM protected and cannot be played here');
    return {
      url: chosen.url,
      mimeType: /HLS/i.test(chosen.streaming) ? 'application/vnd.apple.mpegurl' : 'video/mp4',
    };
  },
};

async function srgComposition(id: string): Promise<{ bu: string; media: any; resources: any[] }> {
  const [bu, mediaId] = [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)];
  const data = await getJson(
    `https://il.srgssr.ch/integrationlayer/2.0/${bu}/mediaComposition/video/${encodeURIComponent(mediaId)}.json`
  );
  const chapter = data?.chapterList?.[0];
  if (!chapter) throw new MediaError('That SRG programme could not be found');
  if (chapter.blockReason) {
    throw new MediaError(`That programme is unavailable (${String(chapter.blockReason).toLowerCase()})`);
  }
  return { bu, media: { ...chapter, title: data?.episode?.title ?? chapter.title }, resources: chapter.resourceList ?? [] };
}
