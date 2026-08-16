/**
 * Small structured logger with an in-memory tail.
 *
 * The point is that a problem report should never be a guessing game: the last
 * few hundred events are always available from the admin panel, without anyone
 * needing shell access to the NAS.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail?: Record<string, unknown>;
}

const RING_SIZE = 500;
const ring: LogEntry[] = [];

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as LogLevel[]).includes(raw as LogLevel) ? (raw as LogLevel) : 'info';
}

const threshold = LEVELS[configuredLevel()];

/** Anything that could carry a secret is masked before it is ever recorded. */
const SECRET_KEYS = /pass|secret|token|key|cookie|authorization|passphrase/i;

function scrub(detail?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRET_KEYS.test(key)) out[key] = '[redacted]';
    else if (typeof value === 'string' && value.length > 300) out[key] = `${value.slice(0, 300)}…`;
    else out[key] = value;
  }
  return out;
}

function emit(level: LogLevel, scope: string, message: string, detail?: Record<string, unknown>): void {
  const entry: LogEntry = { at: Date.now(), level, scope, message, detail: scrub(detail) };

  // The tail is kept even below the console threshold, so turning the level up
  // after something went wrong is not the only way to see debug lines.
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  if (LEVELS[level] < threshold) return;
  const stamp = new Date(entry.at).toISOString().slice(11, 23);
  const tail = entry.detail && Object.keys(entry.detail).length ? ` ${JSON.stringify(entry.detail)}` : '';
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${tail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, detail?: Record<string, unknown>) => emit('debug', scope, message, detail),
    info: (message: string, detail?: Record<string, unknown>) => emit('info', scope, message, detail),
    warn: (message: string, detail?: Record<string, unknown>) => emit('warn', scope, message, detail),
    error: (message: string, detail?: Record<string, unknown>) => emit('error', scope, message, detail),
  };
}

export function recentLogs(options: { level?: LogLevel; limit?: number; scope?: string } = {}): LogEntry[] {
  const min = LEVELS[options.level ?? 'debug'];
  const limit = Math.min(RING_SIZE, Math.max(1, options.limit ?? 200));
  return ring
    .filter((e) => LEVELS[e.level] >= min && (!options.scope || e.scope === options.scope))
    .slice(-limit);
}

export function logsAsText(): string {
  return ring
    .map((e) => {
      const stamp = new Date(e.at).toISOString();
      const tail = e.detail && Object.keys(e.detail).length ? ` ${JSON.stringify(e.detail)}` : '';
      return `${stamp} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}${tail}`;
    })
    .join('\n');
}

export function currentLogLevel(): LogLevel {
  return configuredLevel();
}
