import { MediaError, getJson, hostMatches, type Provider, type ResolvedStream } from './types';
import type { MediaItem } from '../../types';

/**
 * arte, in every language it publishes. The player config API is public and its
 * HLS manifests answer with `Access-Control-Allow-Origin: *`, so playback needs
 * no proxy. Manifest URLs are signed, hence freshStream.
 */

const CONFIG = 'https://api.arte.tv/api/player/v2/config';
const ID_PATTERN = /^\d{6}-\d{3}-[A-Z]$/;

/** The id carries its language so the right audio version comes back. */
function split(id: string): { programId: string; lang: string } {
  const [programId, lang] = id.split('@');
  return { programId, lang: lang || 'de' };
}

async function fetchConfig(id: string): Promise<any> {
  const { programId, lang } = split(id);
  const data = await getJson(`${CONFIG}/${lang}/${encodeURIComponent(programId)}`);
  const attributes = data?.data?.attributes;
  if (!attributes) throw new MediaError('arte did not return anything for that link');
  return attributes;
}

export const arteProvider: Provider = {
  id: 'arte',
  label: 'arte',
  example: 'arte.tv/de/videos/...',

  match(url) {
    if (!hostMatches(url, 'arte.tv')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    // /de/videos/110225-000-A/slug/
    const idx = parts.findIndex((p) => ID_PATTERN.test(p));
    if (idx === -1) return null;
    const lang = /^[a-z]{2}$/.test(parts[0]) ? parts[0] : 'de';
    return `${parts[idx]}@${lang}`;
  },

  async resolve(id): Promise<MediaItem> {
    const a = await fetchConfig(id);
    const meta = a.metadata ?? {};

    if ((a.streams ?? []).length === 0) {
      const until = a.rights?.end ? ` (available until ${String(a.rights.end).slice(0, 10)})` : '';
      throw new MediaError(
        a.rights?.begin
          ? `That arte programme is not currently available${until}`
          : 'That arte programme has no playable stream (it may have expired or be geo-blocked)'
      );
    }

    const image = meta.images?.[0]?.resolutions?.slice(-1)[0]?.url ?? meta.images?.[0]?.url ?? null;
    return {
      source: 'arte',
      sourceId: id,
      url: null,
      title: [meta.title, meta.subtitle].filter(Boolean).join(' – ') || 'arte',
      author: 'arte',
      duration: typeof meta.duration?.seconds === 'number' ? meta.duration.seconds : null,
      thumbnail: image,
    };
  },

  freshStream: async (id): Promise<ResolvedStream> => {
    const a = await fetchConfig(id);
    const streams: any[] = a.streams ?? [];
    if (streams.length === 0) throw new MediaError('That arte programme is no longer available');
    // Prefer the original-language/dubbed main version over audio description.
    const preferred =
      streams.find((s) => /^VOF|VOSTF|VA|VF|DE|OmU/i.test(s.versions?.[0]?.eStat?.ml ?? '')) ?? streams[0];
    return { url: preferred.url, mimeType: 'application/vnd.apple.mpegurl' };
  },
};
