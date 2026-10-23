import type { NotificationType, Prisma } from '@lasustech-cbt/db';
import type { Tx } from './audit';
import { publishRealtimeEvent } from './realtime';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  /** Extra context the client uses to route and style the entry. */
  meta?: Prisma.InputJsonValue;
}

/**
 * Creates one in-app notification per user in a single statement. Must run
 * inside the caller's transaction so the notification and the event that
 * caused it commit together. Duplicate ids are dropped, and an empty list is
 * a no-op (a class with no candidates produces nothing to send).
 */
export async function notifyUsers(tx: Tx, userIds: string[], n: NotificationInput) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;

  const { count } = await tx.notification.createMany({
    data: ids.map((userId) => ({
      userId,
      type: n.type,
      title: n.title,
      body: n.body,
      ...(n.meta === undefined ? {} : { meta: n.meta }),
    })),
  });

  // Broadcast real-time notification to connected users immediately
  void publishRealtimeEvent({
    event: 'notification',
    target: { userIds: ids },
    data: {
      type: n.type,
      title: n.title,
      body: n.body,
      meta: n.meta,
      createdAt: new Date().toISOString(),
    },
  });

  return count;
}

/** "Mon, 20 Oct, 09:00 am" in the university's timezone. */
export const lagosDateTime = (date: Date) =>
  new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
