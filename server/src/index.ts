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
import { initRealtime } from './realtime';

migrate();

const bootstrap = ensureBootstrapAdmin();

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

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
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const server = http.createServer(app);
initRealtime(server);

server.listen(config.port, config.host, () => {
  console.log(`\n  Watch With Friends`);
  console.log(`  listening on http://${config.host}:${config.port}`);
  console.log(`  data dir:    ${config.dataDir}`);
  if (bootstrap) {
    console.log('\n  ================ FIRST RUN ================');
    console.log(`  Admin account created`);
    console.log(`    username: ${bootstrap.username}`);
    console.log(`    password: ${bootstrap.password}`);
    console.log('  Change this password after signing in.');
    console.log('  ===========================================\n');
  }
});

function shutdown(signal: string) {
  console.log(`\n[${signal}] shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
