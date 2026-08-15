import { Router } from 'express';
import { requireAuth } from '../auth';
import { memberRole, roomById } from '../services/rooms';
import { personalStats, roomStats } from '../services/stats';

export const statsRouter = Router();
statsRouter.use(requireAuth);

statsRouter.get('/me', (req, res) => {
  res.json(personalStats(req.user!.id));
});

statsRouter.get('/rooms/:id', (req, res) => {
  const room = roomById(req.params.id);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  // Same visibility rule as the room itself: members, or anyone for a public room.
  const role = memberRole(room.id, req.user!.id);
  if (!role && room.is_public !== 1 && !req.user!.isAdmin) {
    res.status(403).json({ error: 'This room is invite-only' });
    return;
  }
  res.json({ room: { id: room.id, name: room.name }, ...roomStats(room.id) });
});
