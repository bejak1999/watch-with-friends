import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { MediaError, resolveMediaUrl, resolveYoutubePlaylist, searchYoutube, youtubeApiKey } from '../services/media';
import { pickBestStream, resolveArdItem } from '../services/ard';

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

const resolveSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  mode: z.enum(['auto', 'playlist', 'single']).optional(),
});

mediaRouter.post('/resolve', async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Paste a link first' });
    return;
  }
  try {
    const result = await resolveMediaUrl(parsed.data.url, parsed.data.mode || 'auto');
    res.json(result);
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Could not read that link' });
  }
});

mediaRouter.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.status(400).json({ error: 'Type something to search for' });
    return;
  }
  try {
    const items = await searchYoutube(q);
    res.json({ items });
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Search failed' });
  }
});

mediaRouter.get('/youtube-playlist/:id', async (req, res) => {
  try {
    const result = await resolveYoutubePlaylist(req.params.id);
    res.json({ items: result.items, playlistTitle: result.title });
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Import failed' });
  }
});

/** Fresh stream URL for a queued ARD item, resolved when playback starts. */
mediaRouter.get('/ard/:id', async (req, res) => {
  try {
    const item = await resolveArdItem(req.params.id);
    const stream = pickBestStream(item.streams);
    res.json({
      url: stream.url,
      mimeType: stream.mimeType,
      title: item.title,
      duration: item.duration,
      thumbnail: item.thumbnail,
    });
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Could not load that programme' });
  }
});

mediaRouter.get('/capabilities', (_req, res) => {
  res.json({ youtubeApi: Boolean(youtubeApiKey()) });
});
