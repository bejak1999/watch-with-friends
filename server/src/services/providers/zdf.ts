import { MediaError, getJson, getText, hostMatches, type Provider, type ResolvedStream } from './types';
import type { MediaItem } from '../../types';

/**
 * ZDF and its sister channels (3sat, ZDFneo, ZDFinfo) all sit on the same
 * content API. It needs a bearer token that ZDF publishes inside its own web
 * pages - not a secret, just an unauthenticated key that rotates, so it is
 * scraped once and cached rather than hard-coded.
 */

const API = 'https://api.zdf.de';
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

let cachedToken: { value: string; at: number } | null = null;

async function apiToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.value;

  const html = await getText('https://www.zdf.de/');
  const match = html.match(/apiToken[^A-Za-z0-9]+([A-Za-z0-9]{20,})/);
  if (!match) throw new MediaError('Could not read the ZDF API token - the site layout may have changed', 502);
  cachedToken = { value: match[1], at: Date.now() };
  return match[1];
}

async function zdfJson(path: string, hop = 0): Promise<any> {
  const token = await apiToken();
  let doc: any;
  try {
    doc = await getJson(`${API}${path}`, { headers: { 'Api-Auth': `Bearer ${token}` } });
  } catch (err) {
    if (hop > 0) throw err;
    // A rotated token shows up as an auth failure; drop it and try once more.
    cachedToken = null;
    doc = await getJson(`${API}${path}`, { headers: { 'Api-Auth': `Bearer ${await apiToken()}` } });
  }

  // ZDF answers 200 with a "moved-permanently" stub rather than a real 30x
  // whenever a programme has been filed under a new path.
  if (typeof doc?.profile === 'string' && doc.profile.endsWith('/moved-permanently') && doc.location) {
    if (hop >= 3) throw new MediaError('That ZDF page redirects in a loop', 502);
    return zdfJson(String(doc.location), hop + 1);
  }
  return doc;
}

/** The page document id, e.g. "das-boot-serie-100". */
function documentId(url: URL): string | null {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (!last) return null;
  const cleaned = last.replace(/\.html$/i, '');
  return /^[a-z0-9-]+-\d+$/i.test(cleaned) ? cleaned : null;
}

async function playerDoc(id: string): Promise<any> {
  const doc = await zdfJson(`/content/documents/zdf/${id}.json?profile=player-3`);
  const target = doc?.mainVideoContent?.['http://zdf.de/rels/target'];
  if (!target) throw new MediaError('That ZDF page has no video on it');
  return { doc, target };
}

async function streamsFor(id: string): Promise<{ meta: any; formats: any[] }> {
  const { doc, target } = await playerDoc(id);
  const template = target['http://zdf.de/rels/streams/ptmd-template'];
  if (!template) throw new MediaError('That ZDF programme has no playable stream');

  const ptmdPath = template.replace('{playerId}', 'ngplayer_2_4');
  const ptmd = await zdfJson(ptmdPath);

  const formats: any[] = [];
  for (const priority of ptmd?.priorityList ?? []) {
    for (const set of priority?.formitaeten ?? []) {
      for (const q of set?.qualities ?? []) {
        const uri = q?.audio?.tracks?.[0]?.uri;
        if (uri) formats.push({ uri, mimeType: set.mimeType, quality: q.quality, facets: set.facets ?? [] });
      }
    }
  }
  if (formats.length === 0) throw new MediaError('That ZDF programme is not available (it may be geo-blocked)');
  return { meta: doc, formats };
}

export const zdfProvider: Provider = {
  id: 'zdf',
  label: 'ZDF / 3sat',
  example: 'zdf.de/... · 3sat.de/...',

  match(url) {
    if (!hostMatches(url, 'zdf.de', '3sat.de')) return null;
    return documentId(url);
  },

  async resolve(id): Promise<MediaItem> {
    const { doc } = await playerDoc(id);
    const teaser = doc?.teaserImageRef?.layouts ?? {};
    const image = teaser['1920x1080'] ?? teaser['1280x720'] ?? Object.values(teaser)[0] ?? null;

    return {
      source: 'zdf',
      sourceId: id,
      url: null,
      title: doc?.title || 'ZDF',
      author: doc?.['http://zdf.de/rels/brand']?.title ?? 'ZDF',
      duration:
        doc?.mainVideoContent?.['http://zdf.de/rels/target']?.['http://zdf.de/rels/streams/ptmd-template']
          ? (doc?.mainVideoContent?.['http://zdf.de/rels/target']?.duration ?? null)
          : null,
      thumbnail: typeof image === 'string' ? image : null,
    };
  },

  freshStream: async (id): Promise<ResolvedStream> => {
    const { formats } = await streamsFor(id);
    // HLS first so the viewer's resolution picker has a ladder to work with.
    const hls = formats.find((f) => /m3u8|mpegurl/i.test(f.mimeType) || /\.m3u8/i.test(f.uri));
    const chosen = hls ?? formats.find((f) => /mp4/i.test(f.mimeType)) ?? formats[0];
    return {
      url: chosen.uri,
      mimeType: /m3u8|mpegurl/i.test(chosen.mimeType) ? 'application/vnd.apple.mpegurl' : 'video/mp4',
    };
  },
};
