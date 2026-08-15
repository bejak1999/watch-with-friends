import fs from 'fs';
import path from 'path';

/**
 * The restore swap, deliberately kept free of every other import.
 *
 * It has to run before anything opens the database, and TypeScript hoists all
 * imports to the top of the emitted file - so a module that pulled in `./db`,
 * even indirectly, would have the file open before this could move it. Keeping
 * this dependency-free lets the entry point call it first.
 */

function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
}

export function stagingDir(): string {
  return path.join(dataDir(), 'restore-pending');
}

export interface AppliedRestore {
  createdAt: number;
  includesUploads: boolean;
  counts: Record<string, number>;
}

/**
 * Moves a validated backup into place. The previous files are renamed rather
 * than deleted, so a restore that turns out to be wrong is still recoverable
 * from disk.
 */
export function applyPendingRestore(): AppliedRestore | null {
  const staging = stagingDir();
  const manifestFile = path.join(staging, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return null;

  let manifest: AppliedRestore;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as AppliedRestore;
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    return null;
  }

  const root = dataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stagedDb = path.join(staging, 'wwf.db');
  if (!fs.existsSync(stagedDb)) {
    fs.rmSync(staging, { recursive: true, force: true });
    return null;
  }

  const dbFile = path.join(root, 'wwf.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${dbFile}${suffix}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${from}.replaced-${stamp}`);
  }
  fs.renameSync(stagedDb, dbFile);

  const stagedKey = path.join(staging, 'session.key');
  if (fs.existsSync(stagedKey)) {
    const target = path.join(root, 'session.key');
    if (fs.existsSync(target)) fs.renameSync(target, `${target}.replaced-${stamp}`);
    fs.renameSync(stagedKey, target);
  }

  for (const folder of ['avatars', 'uploads']) {
    const source = path.join(staging, folder);
    if (!fs.existsSync(source)) continue;
    const files = fs.readdirSync(source);
    // A database-only backup must not wipe files that are already on disk.
    if (files.length === 0) continue;
    const target = path.join(root, folder);
    fs.mkdirSync(target, { recursive: true });
    for (const name of files) {
      fs.renameSync(path.join(source, name), path.join(target, path.basename(name)));
    }
  }

  fs.rmSync(staging, { recursive: true, force: true });
  return manifest;
}
