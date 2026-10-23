import { Router } from 'express';
import { requireAuth } from '../auth/auth.middleware';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications.controller';

export const notificationsRouter = Router();

// Each user reads and updates only their own notifications; the controller
// scopes every query by req.auth.userId.
notificationsRouter.use(requireAuth, (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

notificationsRouter.get('/', listNotifications);
notificationsRouter.post('/read-all', markAllNotificationsRead);
notificationsRouter.post('/:id/read', markNotificationRead);
