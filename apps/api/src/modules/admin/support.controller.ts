import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';

let supportTableEnsured = false;
export async function ensureSupportTable(): Promise<void> {
  if (supportTableEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reference_no VARCHAR(60) UNIQUE NOT NULL,
        name VARCHAR(120) NOT NULL,
        identifier VARCHAR(60) NOT NULL,
        email VARCHAR(120),
        phone VARCHAR(30),
        category VARCHAR(60) NOT NULL DEFAULT 'EXAM_ACCESS',
        priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
        message TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        admin_reply TEXT,
        replied_at TIMESTAMPTZ(3),
        replied_by VARCHAR(120),
        created_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT NOW()
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_ref ON support_tickets (reference_no)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets (created_at DESC)`);
    supportTableEnsured = true;
    console.log('[Support] support_tickets table ensured in database.');
  } catch (err: any) {
    console.warn('[Support] ensureSupportTable notice:', err?.message);
  }
}

const createSupportSchema = z.object({
  name: z.string().trim().min(2).max(120),
  identifier: z.string().trim().min(2).max(60),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  category: z.string().trim().default('EXAM_ACCESS'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  message: z.string().trim().min(5).max(3000),
});

export async function createPublicSupportTicket(req: Request, res: Response) {
  await ensureSupportTable();
  const body = createSupportSchema.parse(req.body);
  const ref = `LASU-SUP-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `INSERT INTO support_tickets (reference_no, name, identifier, email, phone, category, priority, message, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN')
     RETURNING id, reference_no, name, identifier, email, phone, category, priority, message, status, created_at`,
    ref,
    body.name,
    body.identifier,
    body.email || null,
    body.phone || null,
    body.category,
    body.priority,
    body.message
  );

  const ticket = rows[0];
  res.status(201).json({
    data: {
      id: ticket.id,
      referenceNo: ticket.reference_no,
      name: ticket.name,
      identifier: ticket.identifier,
      category: ticket.category,
      status: ticket.status,
      createdAt: ticket.created_at,
    },
    message: 'Support ticket submitted successfully.',
  });
}

export async function listSupportTickets(req: Request, res: Response) {
  await ensureSupportTable();
  const status = req.query.status ? String(req.query.status) : undefined;
  const category = req.query.category ? String(req.query.category) : undefined;
  const search = req.query.search ? String(req.query.search).trim() : undefined;

  let query = `SELECT * FROM support_tickets WHERE 1=1`;
  const params: any[] = [];

  if (status && status !== 'ALL') {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }

  if (category && category !== 'ALL') {
    params.push(category);
    query += ` AND category = $${params.length}`;
  }

  if (search) {
    params.push(`%${search}%`);
    query += ` AND (name ILIKE $${params.length} OR identifier ILIKE $${params.length} OR reference_no ILIKE $${params.length} OR message ILIKE $${params.length})`;
  }

  query += ` ORDER BY created_at DESC LIMIT 100`;

  const rows = await prisma.$queryRawUnsafe<any[]>(query, ...params);

  res.json({
    data: rows.map((r) => ({
      id: r.id,
      referenceNo: r.reference_no,
      name: r.name,
      identifier: r.identifier,
      email: r.email,
      phone: r.phone,
      category: r.category,
      priority: r.priority,
      message: r.message,
      status: r.status,
      adminReply: r.admin_reply,
      repliedAt: r.replied_at,
      repliedBy: r.replied_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSupportTicket(req: Request, res: Response) {
  await ensureSupportTable();
  const id = String(req.params.id);
  const isUuid = UUID_REGEX.test(id);
  const rows = isUuid
    ? await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM support_tickets WHERE id = $1::uuid OR reference_no = $1 LIMIT 1`,
        id
      )
    : await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM support_tickets WHERE reference_no = $1 LIMIT 1`,
        id
      );

  if (!rows.length) {
    throw Errors.notFound('Support Ticket');
  }

  const r = rows[0];
  res.json({
    data: {
      id: r.id,
      referenceNo: r.reference_no,
      name: r.name,
      identifier: r.identifier,
      email: r.email,
      phone: r.phone,
      category: r.category,
      priority: r.priority,
      message: r.message,
      status: r.status,
      adminReply: r.admin_reply,
      repliedAt: r.replied_at,
      repliedBy: r.replied_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
  });
}

const replySchema = z.object({
  reply: z.string().trim().min(2).max(3000),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).default('RESOLVED'),
});

export async function replySupportTicket(req: Request, res: Response) {
  await ensureSupportTable();
  const id = String(req.params.id);
  const body = replySchema.parse(req.body);
  const adminUser = req.auth?.userId
    ? await prisma.user.findUnique({ where: { id: req.auth.userId }, select: { names: true } })
    : null;
  const adminName = adminUser?.names || 'ICT Administrator';
  const isUuid = UUID_REGEX.test(id);

  const rows = isUuid
    ? await prisma.$queryRawUnsafe<any[]>(
        `UPDATE support_tickets
         SET admin_reply = $1,
             replied_at = NOW(),
             replied_by = $2,
             status = $3,
             updated_at = NOW()
         WHERE id = $4::uuid
         RETURNING *`,
        body.reply,
        adminName,
        body.status,
        id
      )
    : await prisma.$queryRawUnsafe<any[]>(
        `UPDATE support_tickets
         SET admin_reply = $1,
             replied_at = NOW(),
             replied_by = $2,
             status = $3,
             updated_at = NOW()
         WHERE reference_no = $4
         RETURNING *`,
        body.reply,
        adminName,
        body.status,
        id
      );

  if (!rows.length) {
    throw Errors.notFound('Support Ticket');
  }

  const r = rows[0];

  res.json({
    data: {
      id: r.id,
      referenceNo: r.reference_no,
      name: r.name,
      identifier: r.identifier,
      status: r.status,
      adminReply: r.admin_reply,
      repliedAt: r.replied_at,
      repliedBy: r.replied_by,
    },
    message: 'Reply sent successfully.',
  });
}

const updateStatusSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
});

export async function updateSupportTicketStatus(req: Request, res: Response) {
  await ensureSupportTable();
  const id = String(req.params.id);
  const body = updateStatusSchema.parse(req.body);
  const isUuid = UUID_REGEX.test(id);

  const rows = isUuid
    ? await prisma.$queryRawUnsafe<any[]>(
        `UPDATE support_tickets
         SET status = $1, updated_at = NOW()
         WHERE id = $2::uuid
         RETURNING *`,
        body.status,
        id
      )
    : await prisma.$queryRawUnsafe<any[]>(
        `UPDATE support_tickets
         SET status = $1, updated_at = NOW()
         WHERE reference_no = $2
         RETURNING *`,
        body.status,
        id
      );

  if (!rows.length) {
    throw Errors.notFound('Support Ticket');
  }

  res.json({
    data: {
      id: rows[0].id,
      status: rows[0].status,
    },
    message: 'Status updated successfully.',
  });
}
