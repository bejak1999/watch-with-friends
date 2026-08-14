import type { MediaItem } from '../../types';

export class MediaError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ResolvedStream {
  url: string;
  mimeType: string;
}

/**
 * One video site. Everything site-specific lives in a provider so adding the
 * next Mediathek is a single file rather than another branch in a switch.
 */
export interface Provider {
  /** Stored in queue_items.source, so it must stay stable once shipped. */
  readonly id: string;
  readonly label: string;
  /** Shown in the "what can I paste" hint. */
  readonly example?: string;

  /** Returns an opaque id when this provider owns the URL, else null. */
  match(url: URL, raw: string): string | null;

  /** Metadata for the queue. Runs once, when the link is pasted. */
  resolve(id: string, raw: string): Promise<MediaItem>;

  /**
   * Providers whose CDN links are signed and expire must resolve again at play
   * time; the client asks /api/media/stream/<provider>/<id> for a fresh one.
   */
  readonly freshStream?: (id: string) => Promise<ResolvedStream>;
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Shared JSON fetch with a timeout and a browser-ish UA. */
export async function getJson(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new MediaError(`Upstream replied with HTTP ${res.status}`, res.status >= 500 ? 502 : 400);
    return await res.json();
  } catch (err) {
    if (err instanceof MediaError) throw err;
    throw new MediaError('Could not reach that service', 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function getText(url: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new MediaError(`Upstream replied with HTTP ${res.status}`, 502);
    return await res.text();
  } catch (err) {
    if (err instanceof MediaError) throw err;
    throw new MediaError('Could not reach that service', 502);
  } finally {
    clearTimeout(timer);
  }
}

export function hostMatches(url: URL, ...domains: string[]): boolean {
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}
