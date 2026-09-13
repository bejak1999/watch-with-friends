/**
 * The cookies of a YouTube account, used only to get past age gates.
 *
 * Tested before this was built: against a confirmed age-restricted video, every
 * one of yt-dlp's cookieless player clients fails with "Sign in to confirm your
 * age", and OAuth login has not worked since YouTube shut it off in 2024. A
 * signed-in session from an account YouTube has confirmed as an adult is the
 * only road left.
 *
 * These are live credentials, so they are handled like one: written 0600 into
 * the data directory, never sent back over the API, never in a backup, and only
 * ever handed to yt-dlp as a throwaway copy.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';

const FILE = path.join(config.dataDir, 'youtube-cookies.txt');
const MAX_BYTES = 512 * 1024;

/** The cookies a signed-in YouTube session actually depends on. */
const SIGN_IN_COOKIES = ['SID', 'HSID', 'SSID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];

export class CookieFileError extends Error {}

export interface CookieStatus {
  configured: boolean;
  uploadedAt: number | null;
  /** Lines for youtube.com / google.com. */
  entries: number;
  /** Which of the sign-in cookies are present - names only, never values. */
  signIn: string[];
  /** Earliest expiry among the sign-in cookies, when they carry one. */
  expiresAt: number | null;
  expired: boolean;
}

interface Entry {
  domain: string;
  name: string;
  expires: number;
}

/** Netscape cookies.txt, the format every browser exporter and yt-dlp agree on. */
function parse(content: string): Entry[] {
  const out: Entry[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    // HttpOnly cookies are written as comments with this prefix.
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    out.push({ domain: fields[0].toLowerCase(), name: fields[5], expires: Number(fields[4]) || 0 });
  }
  return out;
}

function summarise(content: string, uploadedAt: number | null): CookieStatus {
  const relevant = parse(content).filter((e) => /(^|\.)(youtube|google)\.com$/.test(e.domain.replace(/^\./, '')));
  const signIn = [...new Set(relevant.filter((e) => SIGN_IN_COOKIES.includes(e.name)).map((e) => e.name))];
  const expiries = relevant
    .filter((e) => SIGN_IN_COOKIES.includes(e.name) && e.expires > 0)
    .map((e) => e.expires * 1000);
  const expiresAt = expiries.length ? Math.min(...expiries) : null;
  return {
    configured: true,
    uploadedAt,
    entries: relevant.length,
    signIn,
    expiresAt,
    expired: expiresAt !== null && expiresAt < Date.now(),
  };
}

export function hasCookies(): boolean {
  return fs.existsSync(FILE);
}

export function cookieStatus(): CookieStatus {
  if (!hasCookies()) {
    return { configured: false, uploadedAt: null, entries: 0, signIn: [], expiresAt: null, expired: false };
  }
  try {
    const stat = fs.statSync(FILE);
    return summarise(fs.readFileSync(FILE, 'utf8'), stat.mtimeMs);
  } catch {
    return { configured: true, uploadedAt: null, entries: 0, signIn: [], expiresAt: null, expired: false };
  }
}

/** Validate before storing, so a wrong file is refused now rather than failing at 11pm. */
export function saveCookies(content: string): CookieStatus {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new CookieFileError('That file is far too large to be a cookies.txt export.');
  }
  const status = summarise(content, Date.now());
  if (status.entries === 0) {
    throw new CookieFileError(
      'No youtube.com cookies found. Export them in the Netscape cookies.txt format while signed in to YouTube.'
    );
  }
  if (status.signIn.length === 0) {
    throw new CookieFileError(
      'These cookies are from a signed-out session, so they cannot unlock anything. Sign in first, then export.'
    );
  }
  if (status.expired) {
    throw new CookieFileError('The sign-in cookies in that file have already expired. Export a fresh set.');
  }

  // Write-then-rename, so a half-written file is never what yt-dlp reads.
  const temp = `${FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, FILE);
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {
    /* not every filesystem honours modes */
  }
  return status;
}

export function removeCookies(): void {
  if (hasCookies()) fs.rmSync(FILE, { force: true });
}

/**
 * Run with a private copy of the cookies. yt-dlp writes cookies back when it
 * exits, and two restreams at once writing the same file could corrupt the only
 * copy - so each run gets its own, deleted the moment it is done.
 */
export async function withCookieCopy<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const copy = path.join(config.tmpDir, `yt-cookies-${crypto.randomBytes(8).toString('hex')}.txt`);
  fs.copyFileSync(FILE, copy);
  try {
    fs.chmodSync(copy, 0o600);
  } catch {
    /* best effort */
  }
  try {
    return await fn(copy);
  } finally {
    fs.rmSync(copy, { force: true });
  }
}
