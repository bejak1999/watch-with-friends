/**
 * Restream support: ask yt-dlp for a playable stream when a site refuses to be
 * embedded.
 *
 * This deliberately stays a thin wrapper. yt-dlp is the part that breaks when
 * YouTube changes something, so everything here is built to fail loudly and
 * legibly rather than to be clever: every failure is classified, recorded, and
 * shown to the admin next to the version that produced it.
 */

import { execFile } from 'child_process';
import { createLogger } from './logger';
import { cookieStatus, hasCookies, withCookieCopy, type CookieStatus } from './youtubeCookies';

const log = createLogger('restream');

export type RestreamFailure = 'missing' | 'age' | 'unavailable' | 'botcheck' | 'failed';

export interface RestreamSource {
  /** HLS master manifest, or a single file when no ladder is offered. */
  upstreamUrl: string;
  kind: 'hls' | 'progressive';
  title: string | null;
  duration: number | null;
  /** When the signed upstream URLs stop working. */
  expiresAt: number;
}

export class RestreamError extends Error {
  constructor(
    public kind: RestreamFailure,
    message: string,
    public detail?: string
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Locating yt-dlp                                                     */
/* ------------------------------------------------------------------ */

interface Runner {
  file: string;
  prefix: string[];
}

let runner: Runner | null = null;
let runnerChecked = false;
let version: string | null = null;

function candidates(): Runner[] {
  const list: Runner[] = [];
  if (process.env.YTDLP_PATH) list.push({ file: process.env.YTDLP_PATH, prefix: [] });
  list.push({ file: 'yt-dlp', prefix: [] });
  // A pip install without a console script still works through the module.
  list.push({ file: 'python3', prefix: ['-m', 'yt_dlp'] });
  list.push({ file: 'python', prefix: ['-m', 'yt_dlp'] });
  return list;
}

function run(r: Runner, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      r.file,
      [...r.prefix, ...args],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          (err as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/** Finds a working yt-dlp once and remembers it. */
export async function ensureRunner(): Promise<Runner | null> {
  if (runnerChecked) return runner;
  runnerChecked = true;
  for (const candidate of candidates()) {
    try {
      const { stdout } = await run(candidate, ['--version'], 20000);
      const v = stdout.trim().split('\n').pop() || '';
      if (v) {
        runner = candidate;
        version = v;
        log.info('yt-dlp found', { command: [candidate.file, ...candidate.prefix].join(' '), version: v });
        return runner;
      }
    } catch {
      /* try the next candidate */
    }
  }
  log.warn('yt-dlp not found - restreaming is unavailable', {
    tried: candidates().map((c) => [c.file, ...c.prefix].join(' ')),
  });
  return null;
}

/** Forget the cached probe so an admin can re-check after installing it. */
export function forgetRunner(): void {
  runnerChecked = false;
  runner = null;
  version = null;
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export interface RestreamHealth {
  installed: boolean;
  version: string | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastErrorKind: RestreamFailure | null;
  consecutiveFailures: number;
  looksBroken: boolean;
  /** Whether an age-verified account is stored, and how it has been doing. */
  cookies: CookieStatus;
  cookiesWorkedAt: number | null;
  cookiesRejectedAt: number | null;
}

const state = {
  lastOkAt: null as number | null,
  lastErrorAt: null as number | null,
  lastError: null as string | null,
  lastErrorKind: null as RestreamFailure | null,
  consecutiveFailures: 0,
  cookiesWorkedAt: null as number | null,
  cookiesRejectedAt: null as number | null,
};

/**
 * True once failures look systemic rather than like one awkward video. That is
 * the signal that yt-dlp needs updating, and what the admin banner keys on.
 */
export function looksBroken(): boolean {
  if (!runnerChecked) return false;
  if (!runner) return true;
  return state.consecutiveFailures >= 3;
}

export function restreamHealth(): RestreamHealth {
  return {
    installed: Boolean(runner),
    version,
    lastOkAt: state.lastOkAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    lastErrorKind: state.lastErrorKind,
    consecutiveFailures: state.consecutiveFailures,
    looksBroken: looksBroken(),
    cookies: cookieStatus(),
    cookiesWorkedAt: state.cookiesWorkedAt,
    cookiesRejectedAt: state.cookiesRejectedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

/**
 * Reasons YouTube gives for an age gate, taken verbatim from yt-dlp's own
 * AGE_GATE_REASONS rather than guessed - it is the list that actually decides
 * the outcome upstream, so ours should not drift from it.
 */
const AGE_GATE = /confirm your age|age-restricted|inappropriate|age_verification_required|age_check_required/;

/**
 * Turn yt-dlp's stderr into something worth showing a person. Exported so the
 * mapping can be tested against real yt-dlp output without a live video - age
 * gates in particular are awkward to reproduce on demand.
 */
export function classify(stderr: string): { kind: RestreamFailure; message: string } {
  const s = stderr.toLowerCase();
  // Checked before the bot check on purpose: "Sign in to confirm your age"
  // matches both, and the age gate is the more specific, more useful answer.
  if (AGE_GATE.test(s)) {
    return {
      kind: 'age',
      message:
        'YouTube wants a signed-in, age-verified account for this one. Restreaming cannot talk its way past that.',
    };
  }
  if (/not a bot|sign in to confirm|use --cookies/.test(s)) {
    return {
      kind: 'botcheck',
      message: 'YouTube is asking this server to prove it is not a bot, so restreaming is blocked for now.',
    };
  }
  if (/private video|video unavailable|has been removed|not available|members-only/.test(s)) {
    return { kind: 'unavailable', message: 'That video is private, removed, or blocked in this country.' };
  }
  return {
    kind: 'failed',
    message: 'Restreaming failed. yt-dlp probably needs updating - YouTube changes things often.',
  };
}

/** Upstream URLs carry their own expiry; never trust a cached one past it. */
function expiryOf(url: string): number {
  const m = /[?&/]expire[/=](\d{9,11})/.exec(url);
  const seconds = m ? Number(m[1]) : 0;
  const cap = Date.now() + 4 * 60 * 60 * 1000;
  if (!seconds) return cap;
  // Stop a minute early so a stream never dies mid-segment.
  return Math.min(seconds * 1000 - 60000, cap);
}

interface CacheEntry {
  source: RestreamSource;
}
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<RestreamSource>>();

export function forgetCached(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

async function resolveUncached(pageUrl: string, key: string): Promise<RestreamSource> {
  const r = await ensureRunner();
  if (!r) {
    state.lastErrorAt = Date.now();
    state.lastErrorKind = 'missing';
    state.lastError = 'yt-dlp is not installed on the server';
    throw new RestreamError('missing', 'Restreaming is not set up on this server (yt-dlp is missing).');
  }

  const started = Date.now();
  const baseArgs = ['-J', '--no-warnings', '--no-playlist', '--no-progress', '--socket-timeout', '15'];

  const attempt = async (extra: string[]): Promise<string> => {
    try {
      const res = await run(r, [...baseArgs, ...extra, pageUrl], 60000);
      return res.stdout;
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr || (err as Error).message || '');
      const verdict = classify(stderr);
      const detail = stderr.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) || verdict.message;
      throw new RestreamError(verdict.kind, verdict.message, detail);
    }
  };

  let stdout = '';
  let usedCookies = false;
  try {
    try {
      stdout = await attempt([]);
    } catch (err) {
      // Only an age gate is worth spending the account on. Anything else fails
      // the same way signed in, and every signed-in request is one more thing
      // for YouTube to hold against that account - so it is not used by default.
      if (!(err instanceof RestreamError) || err.kind !== 'age' || !hasCookies()) throw err;
      log.info('age gate - retrying with the stored account', { key });
      usedCookies = true;
      stdout = await withCookieCopy((file) => attempt(['--cookies', file]));
    }
  } catch (err) {
    const e = err instanceof RestreamError ? err : new RestreamError('failed', 'Restreaming failed unexpectedly.');
    if (e.kind === 'age') {
      if (usedCookies) {
        state.cookiesRejectedAt = Date.now();
        e.message =
          'YouTube still wants an age check even with the stored account. Its cookies have probably expired, or the ' +
          'account has not confirmed its age - an admin can upload fresh ones under Admin → Settings → Restream.';
      } else {
        e.message =
          'This video is age-restricted. An admin can store the cookies of an age-verified YouTube account under ' +
          'Admin → Settings → Restream to unlock these.';
      }
    }
    state.lastErrorAt = Date.now();
    state.lastError = e.detail || e.message;
    state.lastErrorKind = e.kind;
    // An age gate or a removed video says nothing about yt-dlp's health. Only
    // failures that point at yt-dlp itself count, or the "needs updating"
    // banner would go up after three age-restricted videos in a row.
    if (e.kind === 'failed' || e.kind === 'botcheck') state.consecutiveFailures += 1;
    log.warn('resolve failed', { key, kind: e.kind, usedCookies, ms: Date.now() - started, detail: state.lastError });
    throw e;
  }
  if (usedCookies) state.cookiesWorkedAt = Date.now();

  let info: any;
  try {
    info = JSON.parse(stdout);
  } catch {
    state.consecutiveFailures += 1;
    throw new RestreamError('failed', 'yt-dlp returned something unreadable.');
  }

  const formats: any[] = Array.isArray(info.formats) ? info.formats : [];
  // One HLS master carries the whole ladder, which is exactly what hls.js and
  // the existing quality picker already know how to drive.
  const manifest = formats.find((f) => f && typeof f.manifest_url === 'string' && f.manifest_url)?.manifest_url;

  let source: RestreamSource;
  if (manifest) {
    source = {
      upstreamUrl: manifest,
      kind: 'hls',
      title: info.title || null,
      duration: typeof info.duration === 'number' ? info.duration : null,
      expiresAt: expiryOf(manifest),
    };
  } else {
    // No ladder: fall back to any single file carrying both picture and sound.
    const progressive = formats
      .filter((f) => f && f.url && f.acodec && f.acodec !== 'none' && f.vcodec && f.vcodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (!progressive) {
      state.consecutiveFailures += 1;
      state.lastErrorAt = Date.now();
      state.lastErrorKind = 'failed';
      state.lastError = 'no playable format returned';
      throw new RestreamError('failed', 'No playable stream was offered for that video.');
    }
    source = {
      upstreamUrl: progressive.url,
      kind: 'progressive',
      title: info.title || null,
      duration: typeof info.duration === 'number' ? info.duration : null,
      expiresAt: expiryOf(progressive.url),
    };
  }

  state.lastOkAt = Date.now();
  state.consecutiveFailures = 0;
  log.info('resolved', { key, kind: source.kind, ms: Date.now() - started, title: source.title });
  return source;
}

/** Resolve a page URL to something playable, caching until the URLs expire. */
export async function resolveRestream(pageUrl: string, key: string): Promise<RestreamSource> {
  const hit = cache.get(key);
  if (hit && hit.source.expiresAt > Date.now() + 30000) return hit.source;

  // Twenty people pressing play at once should still be one yt-dlp run.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = resolveUncached(pageUrl, key)
    .then((source) => {
      cache.set(key, { source });
      return source;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}
