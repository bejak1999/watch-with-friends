import { MediaError, getJson, hostMatches, type Provider } from './types';
import type { MediaItem } from '../../types';

/**
 * Dailymotion is played through its embed player rather than its HLS manifest:
 * the manifest carries a `sec=` token bound to the requesting address, so a URL
 * resolved here returns 403 in the viewer's browser. The embed exposes
 * play/pause/seek, which is all the sync engine needs.
 */
export const dailymotionProvider: Provider = {
  id: 'dailymotion',
  label: 'Dailymotion',
  example: 'dailymotion.com/video/...',

  match(url) {
    if (hostMatches(url, 'dai.ly')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id ?? null;
    }
    if (!hostMatches(url, 'dailymotion.com')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('video');
    const id = idx >= 0 ? parts[idx + 1] : undefined;
    // Ids look like x8xh0zi; strip any trailing slug.
    return id ? id.split('_')[0] : null;
  },

  async resolve(id): Promise<MediaItem> {
    const data = await getJson(
      `https://api.dailymotion.com/video/${encodeURIComponent(id)}?fields=id,title,duration,thumbnail_720_url,owner.screenname`
    );
    if (!data?.id) throw new MediaError('That Dailymotion video could not be found');
    return {
      source: 'dailymotion',
      sourceId: data.id,
      url: `https://www.dailymotion.com/video/${data.id}`,
      title: data.title || 'Dailymotion video',
      author: data['owner.screenname'] ?? null,
      duration: typeof data.duration === 'number' ? data.duration : null,
      thumbnail: data.thumbnail_720_url ?? null,
    };
  },
};
