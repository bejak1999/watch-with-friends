import { arteProvider } from './arte';
import { zdfProvider } from './zdf';
import { dailymotionProvider } from './dailymotion';
import { archiveProvider, peertubeProvider, srgProvider } from './misc';
import { ardProvider } from './ard';
import type { Provider } from './types';

/**
 * Order matters: the first provider that claims a URL wins, so specific hosts
 * come before PeerTube, whose match is shape-based and would otherwise swallow
 * any /w/<uuid> path.
 */
export const PROVIDERS: Provider[] = [
  ardProvider,
  zdfProvider,
  arteProvider,
  srgProvider,
  dailymotionProvider,
  archiveProvider,
  peertubeProvider,
];

export const PROVIDERS_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export interface ProviderMatch {
  provider: Provider;
  id: string;
}

export function matchProvider(raw: string): ProviderMatch | null {
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  for (const provider of PROVIDERS) {
    const id = provider.match(url, raw);
    if (id) return { provider, id };
  }
  return null;
}

/** Human-readable list for the "what can I paste" hint in the UI. */
export function providerHints(): Array<{ id: string; label: string; example?: string }> {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label, example: p.example }));
}

export type { Provider } from './types';
export { MediaError } from './types';
