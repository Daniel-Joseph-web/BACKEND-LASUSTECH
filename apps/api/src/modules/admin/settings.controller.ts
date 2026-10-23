import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { getAll, getGroup, invalidateSettings, SettingGroup, settingSchemas } from '../../lib/settings';

export const getSettings = async (_req: Request, res: Response) => res.json({ data: await getAll() });

export const updateSettings = async (req: Request, res: Response) => {
  const g = String(req.params.group);
  if (!Object.hasOwn(settingSchemas, g)) throw Errors.notFound('Settings group');
  const group = g as SettingGroup;
  const value = settingSchemas[group].parse(req.body);
  const before = await getGroup(group);
  const actor = actorFrom(req, res);

  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: group },
      create: { key: group, value: value as Prisma.InputJsonValue, updatedBy: actor.actorId },
      update: { value: value as Prisma.InputJsonValue, updatedBy: actor.actorId },
    });
    await writeAudit(tx, actor, { action: 'settings.update', targetType: 'Settings', targetId: group, before, after: value });
  });
  invalidateSettings();
  res.json({ data: await getGroup(group) });
};

/** Signs out every non-admin user. Refuses while exams are open unless forced. */
export const flushSessions = async (req: Request, res: Response) => {
  const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
  const open = await prisma.sitting.count({ where: { status: 'OPEN' } });
  if (open && !force) {
    throw Errors.conflict('EXAMS_IN_PROGRESS', `${open} exam sitting(s) are open right now. Signing everyone out would interrupt candidates.`, { open });
  }
  const actor = actorFrom(req, res);
  const result = await prisma.$transaction(async (tx) => {
    const r = await tx.authSession.updateMany({
      where: { revokedAt: null, user: { roles: { none: { role: { key: 'ADMIN' } } } } },
      data: { revokedAt: new Date(), revokedReason: 'ADMIN_FLUSH' },
    });
    await writeAudit(tx, actor, { action: 'security.flush_sessions', targetType: 'AuthSession', targetId: 'bulk', after: { revoked: r.count, forced: force, openSittings: open } });
    return r;
  });
  res.json({ data: { revoked: result.count } });
};