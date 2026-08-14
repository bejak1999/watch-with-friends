import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { MediaError, resolveMediaUrl, resolveYoutubePlaylist, searchYoutube, youtubeApiKey } from '../services/media';
import { PROVIDERS_BY_ID, providerHints } from '../services/providers';
import { searchMediathek } from '../services/providers/mediathek-search';

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

/**
 * Fresh stream URL for a queued item, resolved when playback starts. Providers
 * whose CDN links are signed would otherwise break in a saved playlist.
 */
mediaRouter.get('/stream/:provider/:id(*)', async (req, res) => {
  const provider = PROVIDERS_BY_ID.get(req.params.provider);
  if (!provider?.freshStream) {
    res.status(404).json({ error: 'Unknown provider' });
    return;
  }
  try {
    const stream = await provider.freshStream(req.params.id);
    res.json(stream);
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Could not load that programme' });
  }
});

/** Search every German-language public broadcaster in one go. */
mediaRouter.get('/search-mediathek', async (req, res) => {
  const q = String(req.query.q || '').trim();
  try {
    const items = await searchMediathek(q);
    res.json({ items });
  } catch (err) {
    const status = err instanceof MediaError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Search failed' });
  }
});

mediaRouter.get('/capabilities', (_req, res) => {
  res.json({ youtubeApi: Boolean(youtubeApiKey()), providers: providerHints() });
});
