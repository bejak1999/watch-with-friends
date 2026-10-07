/**
 * Which build is running, and whether a newer image has been published.
 *
 * The image carries the commit it was built from (APP_COMMIT, set by the CI
 * workflow). "Newer" means: the image build on GitHub last succeeded for a
 * different commit - so the check only says "update" once the image actually
 * exists on the registry, not the moment a commit is pushed.
 *
 * It asks the public GitHub API a couple of times a day. No token, nothing
 * about this server is sent. UPDATE_CHECK=off turns it off entirely.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('version');

const COMMIT = (process.env.APP_COMMIT || 'dev').trim();
const BUILT_AT = process.env.APP_BUILT_AT?.trim() || null;
const REPO = (process.env.UPDATE_REPO || 'bejak1999/watch-with-friends').trim();
const ENABLED = (process.env.UPDATE_CHECK || 'on').toLowerCase() !== 'off';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface VersionInfo {
  version: string;
  /** Full commit hash, or "dev" for a build made outside CI. */
  commit: string;
  short: string;
  builtAt: string | null;
}

const info: VersionInfo = {
  version: packageVersion(),
  commit: COMMIT,
  short: COMMIT === 'dev' ? 'dev' : COMMIT.slice(0, 7),
  builtAt: BUILT_AT,
};

export function versionInfo(): VersionInfo {
  return info;
}

export interface UpdateStatus {
  enabled: boolean;
  checkedAt: number | null;
  /** True once a newer image than this one has been published. */
  available: boolean;
  latest: { commit: string; short: string; at: string; title: string } | null;
  /** How many commits this server is behind, when GitHub could tell. */
  behind: number | null;
  /** Newest first, at most 15. */
  changes: Array<{ short: string; title: string; at: string }>;
  error: string | null;
  repo: string;
}

let status: UpdateStatus = {
  enabled: ENABLED,
  checkedAt: null,
  available: false,
  latest: null,
  behind: null,
  changes: [],
  error: null,
  repo: REPO,
};

export function updateStatus(): UpdateStatus {
  return status;
}

async function github<T>(pathname: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${REPO}${pathname}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'watch-with-friends-update-check' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()) as T;
}

let lastAnnounced: string | null = null;

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!ENABLED) return status;
  try {
    // Asking for just one run is not reliable: with the status filter GitHub
    // sometimes hands back an old run first (seen: a two-week-old build instead
    // of yesterday's), which would report "up to date" wrongly. Take a page
    // and pick the newest ourselves.
    const runs = await github<{
      workflow_runs: Array<{ head_sha: string; updated_at: string; created_at: string; run_number: number; display_title: string }>;
    }>('/actions/workflows/docker.yml/runs?branch=main&status=success&per_page=30');
    const run = runs.workflow_runs.slice().sort((a, b) => b.run_number - a.run_number)[0];
    if (!run) throw new Error('no published image found');
    const latest = { commit: run.head_sha, short: run.head_sha.slice(0, 7), at: run.updated_at, title: run.display_title };

    let available = false;
    let behind: number | null = null;
    let changes: UpdateStatus['changes'] = [];

    if (COMMIT !== 'dev' && latest.commit !== COMMIT) {
      try {
        const cmp = await github<{
          status: 'ahead' | 'behind' | 'identical' | 'diverged';
          ahead_by: number;
          commits: Array<{ sha: string; commit: { message: string; committer: { date: string } } }>;
        }>(`/compare/${COMMIT}...${latest.commit}`);
        // "behind" means this server runs something newer than the last image -
        // a local build, say. Only "ahead" is an update.
        available = cmp.status === 'ahead' || cmp.status === 'diverged';
        behind = available ? cmp.ahead_by : 0;
        changes = cmp.commits
          .slice(-15)
          .reverse()
          .map((c) => ({ short: c.sha.slice(0, 7), title: c.commit.message.split('\n')[0], at: c.commit.committer.date }));
      } catch {
        // An unknown commit (rebased away, a fork) cannot be compared; a
        // different published commit is still the best signal there is.
        available = true;
      }
    }

    status = { ...status, checkedAt: Date.now(), available, latest, behind, changes, error: null };
    if (available && lastAnnounced !== latest.commit) {
      lastAnnounced = latest.commit;
      log.info('a newer version is available', { running: info.short, latest: latest.short, behind });
    }
  } catch (err) {
    status = { ...status, checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
    log.warn('update check failed', { message: status.error });
  }
  return status;
}

export function startUpdateChecks(): void {
  log.info('running version', { version: info.version, commit: info.short, builtAt: info.builtAt });
  if (!ENABLED) return;
  const first = setTimeout(() => void checkForUpdate(), 20_000);
  first.unref?.();
  const every = setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
  every.unref?.();
}
