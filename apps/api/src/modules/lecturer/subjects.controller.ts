import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { blankToUndef, uuidParam } from '../../lib/http';

const subjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.preprocess(blankToUndef, z.string().trim().max(50).optional()),
  level: z.preprocess(blankToUndef, z.string().trim().max(80).optional()),
  institution: z.preprocess(blankToUndef, z.string().trim().max(200).optional()),
  category: z.preprocess(
    blankToUndef,
    z
      .enum(['UNIVERSITY', 'SECONDARY', 'PRIMARY', 'PROFESSIONAL', 'ENTRANCE', 'OTHER'])
      .default('OTHER'),
  ),
});

const updateSchema = subjectSchema.partial().extend({
  active: z.boolean().optional(),
});

const present = (s: {
  id: string;
  name: string;
  code: string | null;
  level: string | null;
  institution: string | null;
  category: string | null;
  active: boolean;
  createdAt: Date;
  _count?: { questions: number; exams: number };
}) => ({
  id: s.id,
  name: s.name,
  code: s.code,
  level: s.level,
  institution: s.institution,
  category: s.category,
  active: s.active,
  createdAt: s.createdAt,
  questionCount: s._count?.questions ?? 0,
  examCount: s._count?.exams ?? 0,
});

export const listSubjects = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const subjects = await prisma.subject.findMany({
    where: { createdBy: userId, active: true },
    include: { _count: { select: { questions: true, exams: true } } },
    orderBy: [{ institution: 'asc' }, { name: 'asc' }],
  });
  res.json({ data: subjects.map(present) });
};

export const createSubject = async (req: Request, res: Response) => {
  const body = subjectSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const duplicate = await prisma.subject.findFirst({
    where: {
      createdBy: actor.actorId,
      name: { equals: body.name, mode: 'insensitive' },
      level: body.level ?? null,
    },
    select: { id: true },
  });
  if (duplicate) {
    throw Errors.conflict('SUBJECT_EXISTS', 'You already have a subject with that name and level.');
  }

  const created = await prisma.$transaction(async (tx) => {
    const subject = await tx.subject.create({
      data: {
        createdBy: actor.actorId,
        name: body.name,
        code: body.code,
        level: body.level,
        institution: body.institution,
        category: body.category,
      },
      include: { _count: { select: { questions: true, exams: true } } },
    });
    await writeAudit(tx, actor, {
      action: 'subject.create',
      targetType: 'Subject',
      targetId: subject.id,
      after: { name: subject.name, level: subject.level, institution: subject.institution },
    });
    return subject;
  });

  res.status(201).json({ data: present(created) });
};

export const updateSubject = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = updateSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const existing = await prisma.subject.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound('Subject');
  if (existing.createdBy !== actor.actorId) throw Errors.forbidden();

  const updated = await prisma.$transaction(async (tx) => {
    const subject = await tx.subject.update({
      where: { id },
      data: {
        name: body.name,
        code: body.code,
        level: body.level,
        institution: body.institution,
        category: body.category,
        active: body.active,
      },
      include: { _count: { select: { questions: true, exams: true } } },
    });
    await writeAudit(tx, actor, {
      action: 'subject.update',
      targetType: 'Subject',
      targetId: id,
      before: { name: existing.name, level: existing.level },
      after: { name: subject.name, level: subject.level },
    });
    return subject;
  });

  res.json({ data: present(updated) });
};
