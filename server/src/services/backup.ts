import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { config } from '../config';
import { db } from '../db';
import { stagingDir } from './backup-boot';

/**
 * One-file backup of everything that makes this server itself.
 *
 * Format (v1), deliberately simple so a future version can still read it:
 *
 *   "WWFBAK01"        8 bytes magic
 *   mode              1 byte  0 = gzip only, 1 = gzip then AES-256-GCM
 *   salt              16 bytes, encrypted mode only
 *   iv                12 bytes, encrypted mode only
 *   body              gzip(payload), enciphered when mode = 1
 *   tag               trailing 16 bytes, encrypted mode only
 *
 * payload = 4-byte big-endian manifest length, manifest JSON, then every file
 * concatenated in manifest order. Sizes are known up front, so the whole thing
 * streams and a 40 GB uploads folder never lands in memory.
 */

const MAGIC = Buffer.from('WWFBAK01', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
/** Matches the password hashing cost, which is a sane desktop-grade KDF. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export interface BackupEntry {
  name: string;
  size: number;
}

export interface BackupManifest {
  app: 'watch-with-friends';
  version: 1;
  createdAt: number;
  includesUploads: boolean;
  counts: Record<string, number>;
  entries: BackupEntry[];
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LEN, SCRYPT_PARAMS);
}

function listFiles(dir: string, prefix: string): BackupEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ name: `${prefix}/${e.name}`, size: fs.statSync(path.join(dir, e.name)).size }));
}

function sourcePath(name: string): string {
  if (name === 'wwf.db') return path.join(config.tmpDir, 'backup-snapshot.db');
  if (name === 'session.key') return path.join(config.dataDir, 'session.key');
  const [folder, ...rest] = name.split('/');
  return path.join(config.dataDir, folder, rest.join('/'));
}

/**
 * VACUUM INTO gives a consistent snapshot without stopping the server, which a
 * plain file copy cannot promise while WAL writes are in flight.
 */
function snapshotDatabase(): string {
  const target = path.join(config.tmpDir, 'backup-snapshot.db');
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

function tableCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ['users', 'rooms', 'queue_items', 'playlists', 'messages', 'uploads', 'watch_stats', 'play_log']) {
    try {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

export interface BackupResult {
  file: string;
  manifest: BackupManifest;
  cleanup: () => void;
}

/** Builds the archive in the temp dir and hands back a path to stream out. */
export async function createBackup(options: { includeUploads: boolean; passphrase?: string }): Promise<BackupResult> {
  const snapshot = snapshotDatabase();

  const entries: BackupEntry[] = [{ name: 'wwf.db', size: fs.statSync(snapshot).size }];
  const sessionKey = path.join(config.dataDir, 'session.key');
  if (fs.existsSync(sessionKey)) {
    entries.push({ name: 'session.key', size: fs.statSync(sessionKey).size });
  }
  entries.push(...listFiles(path.join(config.dataDir, 'avatars'), 'avatars'));
  if (options.includeUploads) {
    entries.push(...listFiles(config.uploadDir, 'uploads'));
  }

  const manifest: BackupManifest = {
    app: 'watch-with-friends',
    version: 1,
    createdAt: Date.now(),
    includesUploads: options.includeUploads,
    counts: tableCounts(),
    entries,
  };

  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifestJson.length, 0);

  async function* payload(): AsyncGenerator<Buffer> {
    yield header;
    yield manifestJson;
    for (const entry of entries) {
      const stream = fs.createReadStream(sourcePath(entry.name));
      for await (const chunk of stream) yield chunk as Buffer;
    }
  }

  const outPath = path.join(config.tmpDir, `backup-${Date.now()}.wwfbak`);
  const out = fs.createWriteStream(outPath);
  const encrypted = Boolean(options.passphrase);

  const preamble: Buffer[] = [MAGIC, Buffer.from([encrypted ? 1 : 0])];
  let cipher: crypto.CipherGCM | null = null;
  if (encrypted) {
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(options.passphrase!, salt), iv);
    preamble.push(salt, iv);
  }
  out.write(Buffer.concat(preamble));

  const stages: NodeJS.ReadWriteStream[] = [zlib.createGzip({ level: 6 })];
  if (cipher) stages.push(cipher);
  await pipeline(Readable.from(payload()), ...(stages as [NodeJS.ReadWriteStream]), out);

  if (cipher) {
    // GCM only knows the tag once everything is through, so it trails the body.
    await fs.promises.appendFile(outPath, cipher.getAuthTag());
  }

  return {
    file: outPath,
    manifest,
    cleanup: () => {
      fs.promises.unlink(outPath).catch(() => undefined);
      fs.promises.unlink(snapshot).catch(() => undefined);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Restore                                                             */
/* ------------------------------------------------------------------ */

export class BackupError extends Error {}

export interface RestorePreview {
  manifest: BackupManifest;
  stagedAt: string;
}

export { stagingDir };

/**
 * Unpacks into a staging folder and validates it. Nothing live is touched:
 * swapping the database out from under an open connection is asking for
 * corruption, so the swap happens on the next start instead.
 */
export async function stageRestore(archivePath: string, passphrase?: string): Promise<RestorePreview> {
  const size = fs.statSync(archivePath).size;
  if (size < MAGIC.length + 1) throw new BackupError('That file is too small to be a backup');

  const head = Buffer.alloc(MAGIC.length + 1 + SALT_LEN + IV_LEN);
  const fd = await fs.promises.open(archivePath, 'r');
  try {
    await fd.read(head, 0, head.length, 0);
  } finally {
    await fd.close();
  }

  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError('That is not a Watch With Friends backup file');
  }
  const mode = head[MAGIC.length];
  if (mode !== 0 && mode !== 1) throw new BackupError('Unsupported backup format');
  const encrypted = mode === 1;
  if (encrypted && !passphrase) throw new BackupError('This backup is encrypted - enter its password');
  if (!encrypted && passphrase) {
    throw new BackupError('This backup is not encrypted, so it needs no password');
  }

  const bodyStart = MAGIC.length + 1 + (encrypted ? SALT_LEN + IV_LEN : 0);
  const bodyEnd = encrypted ? size - TAG_LEN : size;
  if (bodyEnd <= bodyStart) throw new BackupError('That backup file is truncated');

  const stages: NodeJS.ReadWriteStream[] = [];
  if (encrypted) {
    const salt = head.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN);
    const iv = head.subarray(MAGIC.length + 1 + SALT_LEN, bodyStart);
    const tag = Buffer.alloc(TAG_LEN);
    const tagFd = await fs.promises.open(archivePath, 'r');
    try {
      await tagFd.read(tag, 0, TAG_LEN, size - TAG_LEN);
    } finally {
      await tagFd.close();
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase!, salt), iv);
    decipher.setAuthTag(tag);
    stages.push(decipher);
  }
  stages.push(zlib.createGunzip());

  const staging = stagingDir();
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(staging, 'avatars'), { recursive: true });
  await fs.promises.mkdir(path.join(staging, 'uploads'), { recursive: true });

  const plainPath = path.join(config.tmpDir, `restore-${Date.now()}.bin`);
  try {
    await pipeline(
      fs.createReadStream(archivePath, { start: bodyStart, end: bodyEnd - 1 }),
      ...(stages as [NodeJS.ReadWriteStream]),
      fs.createWriteStream(plainPath)
    );
  } catch (err) {
    await fs.promises.rm(plainPath, { force: true });
    // A wrong password fails the GCM tag check, which surfaces here.
    throw new BackupError(
      encrypted
        ? 'Could not decrypt that backup - wrong password, or the file is damaged'
        : 'That backup file is damaged and could not be read'
    );
  }

  const manifest = await unpackPayload(plainPath, staging);
  await fs.promises.rm(plainPath, { force: true });

  // Refuse a backup from a newer build: its schema could be ahead of ours.
  const restoredVersion = readUserVersion(path.join(staging, 'wwf.db'));
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (restoredVersion > currentVersion) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    throw new BackupError(
      `That backup came from a newer version (schema ${restoredVersion} vs ${currentVersion}). Update this server first.`
    );
  }

  await fs.promises.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, stagedAt: staging };
}

async function unpackPayload(plainPath: string, staging: string): Promise<BackupManifest> {
  const total = fs.statSync(plainPath).size;
  const fd = await fs.promises.open(plainPath, 'r');
  let manifest: BackupManifest;
  let offset: number;
  try {
    const lenBuf = Buffer.alloc(4);
    await fd.read(lenBuf, 0, 4, 0);
    const manifestLength = lenBuf.readUInt32BE(0);
    if (manifestLength <= 0 || manifestLength > 8 * 1024 * 1024 || manifestLength + 4 > total) {
      throw new BackupError('That backup has an unreadable index');
    }

    const manifestBuf = Buffer.alloc(manifestLength);
    await fd.read(manifestBuf, 0, manifestLength, 4);
    try {
      manifest = JSON.parse(manifestBuf.toString('utf8')) as BackupManifest;
    } catch {
      throw new BackupError('That backup has an unreadable index');
    }
    offset = 4 + manifestLength;
  } finally {
    await fd.close();
  }

  if (manifest.app !== 'watch-with-friends') throw new BackupError('That backup is from a different application');
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new BackupError('That backup contains no files');
  }

  for (const entry of manifest.entries) {
    const size = Number(entry.size);
    if (!Number.isInteger(size) || size < 0 || offset + size > total) {
      throw new BackupError('That backup file is truncated');
    }
    const dest = path.join(staging, safeEntryName(entry.name));
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    if (size === 0) {
      await fs.promises.writeFile(dest, '');
    } else {
      // A ranged read stream copies the bytes for us. Hand-rolling this with a
      // reused Buffer corrupts the output, because a backpressured write keeps
      // the buffer by reference and the next read overwrites it.
      await pipeline(
        fs.createReadStream(plainPath, { start: offset, end: offset + size - 1 }),
        fs.createWriteStream(dest)
      );
    }
    offset += size;
  }

  if (!fs.existsSync(path.join(staging, 'wwf.db'))) {
    throw new BackupError('That backup has no database in it');
  }
  return manifest;
}

/** Entry names come from a file someone uploaded, so treat them as hostile. */
function safeEntryName(name: string): string {
  const normalised = name.replace(/\\/g, '/');
  if (normalised.includes('..') || normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) {
    throw new BackupError('That backup contains an unsafe file path');
  }
  const [folder] = normalised.split('/');
  if (!['wwf.db', 'session.key', 'avatars', 'uploads'].includes(folder)) {
    throw new BackupError(`That backup contains an unexpected entry: ${normalised.slice(0, 40)}`);
  }
  return normalised;
}

function readUserVersion(dbPath: string): number {
  // Read the header directly rather than opening a second connection.
  const buf = Buffer.alloc(64);
  const fd = fs.openSync(dbPath, 'r');
  try {
    fs.readSync(fd, buf, 0, 64, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.subarray(0, 15).toString('ascii') !== 'SQLite format 3') {
    throw new BackupError('The database inside that backup is not a SQLite file');
  }
  return buf.readUInt32BE(60);
}

export function pendingRestore(): BackupManifest | null {
  const file = path.join(stagingDir(), 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BackupManifest;
  } catch {
    return null;
  }
}

export function cancelRestore(): void {
  fs.rmSync(stagingDir(), { recursive: true, force: true });
}
