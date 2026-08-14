import { MediaError } from './types';
import type { MediaItem } from '../../types';

/**
 * Search across every German-language public broadcaster at once.
 *
 * MediathekViewWeb indexes the ARD, ZDF, 3sat, arte, ORF, SRF, DW and the
 * regional channels, and hands back plain progressive MP4 URLs. Those are not
 * signed, so unlike the per-site providers the result can be queued directly as
 * a normal link - no re-resolution needed at play time.
 */

const ENDPOINT = 'https://mediathekviewweb.de/api/query';

interface MvwResult {
  channel: string;
  topic: string;
  title: string;
  timestamp: number;
  duration: number;
  url_video: string;
  url_video_low?: string;
  url_video_hd?: string;
  url_website?: string;
}

export async function searchMediathek(query: string, limit = 30): Promise<MediaItem[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new MediaError('Type something to search for');

  const body = JSON.stringify({
    queries: [{ fields: ['title', 'topic'], query: trimmed }],
    sortBy: 'timestamp',
    sortOrder: 'desc',
    future: false,
    offset: 0,
    size: Math.min(60, Math.max(1, limit)),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let payload: any;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      // The API insists on text/plain; sending JSON content-type returns an error.
      headers: { 'Content-Type': 'text/plain' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new MediaError(`MediathekViewWeb replied with HTTP ${res.status}`, 502);
    payload = await res.json();
  } catch (err) {
    if (err instanceof MediaError) throw err;
    throw new MediaError('The Mediathek search is not reachable right now', 502);
  } finally {
    clearTimeout(timer);
  }

  if (payload?.err) throw new MediaError('The Mediathek search rejected that query');

  const results: MvwResult[] = payload?.result?.results ?? [];
  return results
    .filter((r) => r.url_video || r.url_video_hd)
    .map((r) => {
      // Prefer HD, but these are progressive files - no adaptive ladder here.
      const url = r.url_video_hd || r.url_video;
      const topic = (r.topic || '').trim();
      const title = (r.title || '').trim();
      return {
        // A plain unsigned file, so it needs no re-resolution at play time.
        source: 'mediathek' as const,
        sourceId: url,
        url,
        title: topic && !title.startsWith(topic) ? `${topic} – ${title}` : title || topic || 'Mediathek',
        author: r.channel || null,
        duration: typeof r.duration === 'number' && r.duration > 0 ? r.duration : null,
        thumbnail: null,
      };
    });
}
