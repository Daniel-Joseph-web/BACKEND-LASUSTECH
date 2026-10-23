import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { uuidParam } from '../../lib/http';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

/** Newest first, with the caller's unread count for the bell badge. */
export const listNotifications = async (req: Request, res: Response) => {
  const { limit } = listQuery.parse(req.query);
  const userId = req.auth!.userId;

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  res.json({ data: items, meta: { unread } });
};

export const markNotificationRead = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const userId = req.auth!.userId;

  const found = await prisma.notification.findFirst({
    where: { id, userId },
    select: { id: true, readAt: true },
  });
  if (!found) throw Errors.notFound('Notification');

  if (!found.readAt) {
    await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }
  res.json({ data: { id } });
};

export const markAllNotificationsRead = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ data: { updated: result.count } });
};
