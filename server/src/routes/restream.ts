/**
 * Streams a video through this server when the site refuses to be embedded.
 *
 * Everything upstream is signed by us before a browser ever sees it. Two rules
 * keep this from turning into an open proxy for the whole internet:
 *
 *   1. yt-dlp is only ever handed a URL this file built from a known source and
 *      a validated id - never a string a user sent.
 *   2. Every upstream URL is HMAC-signed, and the proxy refuses anything that
 *      is not both correctly signed and pointed at Google's video hosts.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { Readable, pipeline } from 'stream';
import { z } from 'zod';
import { config } from '../config';
import { getSettingBool, getSettingNumber } from '../db';
import { requireAuth } from '../auth';
import { createLogger } from '../services/logger';
import { RestreamError, resolveRestream } from '../services/ytdlp';

const log = createLogger('restream');

export const restreamRouter = Router();

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

type Leg = 'master' | 'variant' | 'seg';

function sign(leg: Leg, url: string): string {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${leg}|${url}`)
    .digest('base64url')
    .slice(0, 32);
}

/**
 * The .m3u8 suffix is load-bearing: the player picks hls.js by looking at the
 * extension, and a bare /master would be fed to a <video> tag as if it were a
 * file.
 */
function proxyPath(leg: Leg, url: string): string {
  const u = Buffer.from(url, 'utf8').toString('base64url');
  const name = leg === 'seg' ? 'seg' : `${leg}.m3u8`;
  return `/api/restream/${name}?u=${encodeURIComponent(u)}&s=${sign(leg, url)}`;
}

/** Only Google's video hosts, even for a correctly signed URL. */
function allowedHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'googlevideo.com' || h.endsWith('.googlevideo.com') || h.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function unwrap(leg: Leg, raw: unknown, sig: unknown): string | null {
  if (typeof raw !== 'string' || typeof sig !== 'string') return null;
  let url: string;
  try {
    url = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(leg, url);
  // Constant-time compare, and only on equal lengths or timingSafeEqual throws.
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  if (!allowedHost(url)) return null;
  return url;
}

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

const resolveSchema = z.object({
  source: z.literal('youtube'),
  sourceId: z.string().regex(/^[A-Za-z0-9_-]{6,20}$/, 'not a video id'),
});

/** Built here, never taken from the request, so yt-dlp cannot be aimed anywhere. */
function pageUrlFor(source: string, id: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

restreamRouter.post('/resolve', requireAuth, async (req, res) => {
  if (!getSettingBool('restream_enabled')) {
    res.status(403).json({ error: 'Restreaming is switched off on this server.', kind: 'disabled' });
    return;
  }
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Not something that can be restreamed.', kind: 'failed' });
    return;
  }

  const { source, sourceId } = parsed.data;
  try {
    const resolved = await resolveRestream(pageUrlFor(source, sourceId), `${source}:${sourceId}`);
    log.info('handing out a restream', { user: req.user!.username, source, sourceId, kind: resolved.kind });
    res.json({
      url: proxyPath(resolved.kind === 'hls' ? 'master' : 'seg', resolved.upstreamUrl),
      kind: resolved.kind,
      title: resolved.title,
      duration: resolved.duration,
      maxHeight: getSettingNumber('restream_max_height') || 0,
    });
  } catch (err) {
    if (err instanceof RestreamError) {
      res.status(502).json({ error: err.message, kind: err.kind });
      return;
    }
    log.error('resolve blew up', { message: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Restreaming failed unexpectedly.', kind: 'failed' });
  }
});

/* ------------------------------------------------------------------ */
/* Manifest rewriting                                                  */
/* ------------------------------------------------------------------ */

const UPSTREAM_HEADERS = {
  // Google is markedly happier serving a browser-shaped request.
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  accept: '*/*',
};

async function fetchUpstream(
  url: string,
  extra: Record<string, string> = {},
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(url, {
      headers: { ...UPSTREAM_HEADERS, ...extra },
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

function absolute(line: string, base: string): string {
  try {
    return new URL(line, base).toString();
  } catch {
    return line;
  }
}

interface Rendition {
  tag: string;
  url: string;
  height: number;
  codecs: string;
  bandwidth: number;
  order: number;
}

/**
 * YouTube lists most heights several times: once as H.264, once as VP9, and the
 * smallest ones again with a second, weaker audio track. hls.js offers each as
 * its own level, which is where "144p, 144p, 144p" in the picker came from.
 * Keep one per height - H.264 first, because every browser decodes it cheaply,
 * then real AAC over the HE-AAC variant, then the higher bitrate.
 */
function pickOnePerHeight(renditions: Rendition[]): Rendition[] {
  const score = (r: Rendition) => (/avc1/i.test(r.codecs) ? 4 : 0) + (/mp4a\.40\.2/i.test(r.codecs) ? 2 : 0);
  const best = new Map<number, Rendition>();
  for (const r of renditions) {
    const current = best.get(r.height);
    if (!current || score(r) > score(current) || (score(r) === score(current) && r.bandwidth > current.bandwidth)) {
      best.set(r.height, r);
    }
  }
  return [...best.values()].sort((a, b) => a.order - b.order);
}

/**
 * Rewrite the master playlist: one rendition per height, drop the ones taller
 * than the admin's cap, and point everything that is left back at us.
 *
 * The cap is applied here rather than in the browser on purpose - a viewer
 * cannot opt back into 4K and saturate the uplink, because the higher rungs
 * never reach them.
 */
function rewriteMaster(body: string, base: string, maxHeight: number): string {
  const lines = body.split(/\r?\n/);
  const header: string[] = [];
  const renditions: Rendition[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(line);
      renditions.push({
        tag: line,
        url: (lines[i + 1] ?? '').trim(),
        height: res ? Number(res[2]) : 0,
        codecs: /CODECS="([^"]*)"/.exec(line)?.[1] ?? '',
        bandwidth: Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0),
        order: renditions.length,
      });
      i += 1; // the URL line belongs to this tag
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('URI="')) {
      header.push(line.replace(/URI="([^"]+)"/, (_m, uri) => `URI="${proxyPath('variant', absolute(uri, base))}"`));
      continue;
    }
    if (line.trim()) header.push(line);
  }

  const unique = pickOnePerHeight(renditions);

  // Keep the ladder on one audio track. YouTube hangs its smallest rung on a
  // weaker HE-AAC track and everything else on AAC, so switching quality made
  // the player swap audio tracks mid-stream. One 144p is not worth that.
  const groupOf = (r: Rendition) => /(?:^|[:,])AUDIO="([^"]*)"/.exec(r.tag)?.[1] ?? '';
  const counts = new Map<string, number>();
  for (const r of unique) counts.set(groupOf(r), (counts.get(groupOf(r)) ?? 0) + 1);
  const mainGroup = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const sameAudio = unique.filter((r) => groupOf(r) === mainGroup);
  const ladder = sameAudio.length > 0 ? sameAudio : unique;

  let kept = maxHeight > 0 ? ladder.filter((r) => r.height <= maxHeight) : ladder;
  // A cap below the lowest rung would otherwise leave nothing to play at all.
  if (kept.length === 0 && ladder.length > 0) {
    log.warn('cap removed every rendition, falling back to the smallest', { maxHeight });
    kept = [ladder.reduce((a, b) => (a.height <= b.height ? a : b))];
  }
  // Drop the audio track nothing references any more, so the player cannot
  // start on it by default.
  const out = header.filter(
    (l) => !(mainGroup && l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(l) && !l.includes(`GROUP-ID="${mainGroup}"`))
  );
  for (const r of kept) out.push(r.tag, proxyPath('variant', absolute(r.url, base)));
  return out.join('\n');
}

/** Rewrite a variant playlist so its segments come through us too. */
function rewriteVariant(body: string, base: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-(MAP|KEY|PART|PRELOAD-HINT)/.test(trimmed) && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/, (_m, uri) => `URI="${proxyPath('seg', absolute(uri, base))}"`);
        }
        return line;
      }
      return proxyPath('seg', absolute(trimmed, base));
    })
    .join('\n');
}

restreamRouter.get('/master.m3u8', requireAuth, async (req, res) => {
  const url = unwrap('master', req.query.u, req.query.s);
  if (!url) {
    res.status(403).type('text/plain').send('bad signature');
    return;
  }
  try {
    const upstream = await fetchUpstream(url);
    if (!upstream.ok) {
      res.status(502).type('text/plain').send(`upstream said ${upstream.status}`);
      return;
    }
    const body = await upstream.text();
    const cap = getSettingNumber('restream_max_height') || 0;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewriteMaster(body, url, cap));
  } catch (err) {
    log.warn('master fetch failed', { message: err instanceof Error ? err.message : String(err) });
    res.status(502).type('text/plain').send('could not reach the stream');
  }
});

restreamRouter.get('/variant.m3u8', requireAuth, async (req, res) => {
  const url = unwrap('variant', req.query.u, req.query.s);
  if (!url) {
    res.status(403).type('text/plain').send('bad signature');
    return;
  }
  try {
    const upstream = await fetchUpstream(url);
    if (!upstream.ok) {
      res.status(502).type('text/plain').send(`upstream said ${upstream.status}`);
      return;
    }
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewriteVariant(body, url));
  } catch (err) {
    log.warn('variant fetch failed', { message: err instanceof Error ? err.message : String(err) });
    res.status(502).type('text/plain').send('could not reach the stream');
  }
});

/** A segment that stops sending for this long is abandoned, not waited on forever. */
const SEG_IDLE_MS = 20000;

/**
 * Raw bytes: segments, and whole files when there is no HLS ladder.
 *
 * The upstream download is tied to the viewer's request. hls.js abandons
 * requests constantly - every seek and every quality switch - and the old
 * plain pipe kept pulling from Google after the browser had gone, holding a
 * connection open on this server each time. A stalled upstream also hung
 * forever, because the timeout only ever covered the response headers.
 */
restreamRouter.get('/seg', requireAuth, async (req, res) => {
  const url = unwrap('seg', req.query.u, req.query.s);
  if (!url) {
    res.status(403).type('text/plain').send('bad signature');
    return;
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  let idle: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), SEG_IDLE_MS);
  };

  try {
    touch();
    // Seeking a progressive file is a Range request, so it has to be passed on.
    const range = req.headers.range;
    const upstream = await fetchUpstream(url, range ? { range } : {}, controller.signal);
    if (!upstream.ok && upstream.status !== 206) {
      clearTimeout(idle);
      res
        .status(upstream.status === 403 ? 410 : 502)
        .type('text/plain')
        .send(`upstream said ${upstream.status}`);
      return;
    }
    res.status(upstream.status === 206 ? 206 : 200);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(header);
      if (v) res.setHeader(header, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (!upstream.body) {
      clearTimeout(idle);
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', touch);
    // pipeline, not pipe: when either side closes early it tears down the other.
    pipeline(body, res, (err) => {
      clearTimeout(idle);
      if (err && !controller.signal.aborted) log.debug('segment stream ended early', { message: err.message });
    });
  } catch (err) {
    clearTimeout(idle);
    if (controller.signal.aborted) return; // the viewer left or it stalled - nothing to answer
    log.warn('segment fetch failed', { message: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) res.status(502).type('text/plain').send('could not reach the stream');
  }
});
