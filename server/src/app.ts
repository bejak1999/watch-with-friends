import http from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { getSetting, migrate } from './db';
import { attachUser, ensureBootstrapAdmin } from './auth';
import { authRouter } from './routes/auth';
import { roomsRouter } from './routes/rooms';
import { mediaRouter } from './routes/media';
import { playlistsRouter } from './routes/playlists';
import { uploadsRouter } from './routes/uploads';
import { adminRouter } from './routes/admin';
import { avatarRouter } from './routes/avatars';
import { statsRouter } from './routes/stats';
import { initRealtime } from './realtime';
import { sweepExpired } from './services/rateLimit';
import { createLogger, currentLogLevel } from './services/logger';

const log = createLogger('http');
const boot = createLogger('boot');

migrate();

const bootstrap = ensureBootstrapAdmin();

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');

/**
 * Baseline hardening. No CSP: the player deliberately embeds YouTube, Vimeo and
 * Twitch frames and loads their SDKs, so a useful policy would have to allow
 * exactly what an attacker would want anyway.
 */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // We embed others; nobody embeds us. Stops clickjacking of the admin panel.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

/**
 * One line per API request, after the response is sent so the status and the
 * duration are known. Slow or failing requests are raised a level so they
 * still show up at the default LOG_LEVEL=info.
 */
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') || req.path === '/api/health') return next();
  const started = Date.now();
  // Routers rewrite req.url as they dispatch, so the full path has to be taken
  // now - by the time 'finish' runs, req.path is the router-relative tail.
  const fullPath = req.path;
  res.on('finish', () => {
    const ms = Date.now() - started;
    const detail = {
      status: res.statusCode,
      ms,
      user: req.user?.username,
      ip: req.ip,
    };
    const line = `${req.method} ${fullPath}`;
    if (res.statusCode >= 500) log.error(line, detail);
    else if (res.statusCode >= 400 || ms > 3000) log.warn(line, detail);
    else log.debug(line, detail);
  });
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: getSetting('site_name'), version: '1.0.0' });
});

app.get('/api/config', (_req, res) => {
  res.json({ siteName: getSetting('site_name') });
});

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/media', mediaRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/users', avatarRouter);
app.use('/api/stats', statsRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown endpoint' });
});

// ---- static client (production build) ----
if (fs.existsSync(config.clientDir)) {
  app.use(
    express.static(config.clientDir, {
      index: false,
      setHeaders: (res, filePath) => {
        // Hashed asset filenames are safe to cache hard; index.html is not.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(config.clientDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Watch With Friends API is running. Start the Vite dev server for the UI.');
  });
}

// ---- error handler ----
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error('unhandled error', {
    path: req.originalUrl,
    method: req.method,
    user: req.user?.username,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const server = http.createServer(app);
initRealtime(server);

// Decayed login counters are inert but would otherwise accumulate forever.
sweepExpired();
setInterval(sweepExpired, 60 * 60 * 1000).unref();

server.listen(config.port, config.host, () => {
  console.log(`\n  Watch With Friends`);
  console.log(`  listening on http://${config.host}:${config.port}`);
  console.log(`  data dir:    ${config.dataDir}`);
  const level = currentLogLevel();
  console.log(`  log level:   ${level}${level === 'debug' ? '' : ' (set LOG_LEVEL=debug for everything)'}`);
  boot.info('server started', {
    port: config.port,
    dataDir: config.dataDir,
    node: process.version,
    trustProxy: config.trustProxy,
  });
  if (bootstrap.created) {
    console.log('\n  ================ FIRST RUN ================');
    console.log(`  Admin account created`);
    console.log(`    username: ${bootstrap.created.username}`);
    console.log(`    password: ${bootstrap.created.password}`);
    console.log('  Change this password after signing in.');
    console.log('  ===========================================\n');
  }
  if (bootstrap.ignoredEnv) {
    const { username, existing } = bootstrap.ignoredEnv;
    console.log('\n  ============== HEADS UP ===================');
    console.log('  ADMIN_USERNAME / ADMIN_PASSWORD were set, but this database');
    console.log('  already has accounts, so they were IGNORED.');
    console.log('');
    console.log(`  You asked for: ${username}`);
    console.log(`  Accounts that exist: ${existing.join(', ')}`);
    console.log('');
    console.log('  Those variables only apply to a brand new database. To change');
    console.log('  a password now, run:');
    console.log('');
    console.log(`    node server/dist/admin-cli.js reset ${username} <new-password>`);
    console.log('');
    console.log('  (from the host: docker exec -it <container> node server/dist/admin-cli.js list)');
    console.log('  ===========================================\n');
  }
});

// A crash that takes the container down should leave a reason behind.
process.on('uncaughtException', (err) => {
  boot.error('uncaught exception', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  boot.error('unhandled rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

function shutdown(signal: string) {
  boot.info('shutting down', { signal });
  console.log(`\n[${signal}] shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
