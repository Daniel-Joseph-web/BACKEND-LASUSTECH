import type { Request, Response } from 'express';
import { z } from 'zod';
import { Errors } from './errors';

// ---------- query / params ----------
export const pageShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const pageMeta = (page: number, pageSize: number, total: number) => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});

export function uuidParam(req: Request, name = 'id'): string {
  const parsed = z.uuid().safeParse(req.params[name]);
  if (!parsed.success) throw Errors.notFound();
  return parsed.data;
}

// ---------- blank-string handling for forms ----------
export const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
export const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

// ---------- dates (all calendar dates are Africa/Lagos, UTC+1, no DST) ----------
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That is not a real date.');

export const parseDay = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
export const todayLagos = () =>
  parseDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date()));
export const LAGOS_OFFSET_MS = 60 * 60 * 1000;

// ---------- CSV ----------
export function toCsv(header: string[], rows: unknown[][]): string {
  const esc = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

export function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv);
}

// ---------- DB error helper ----------
export async function orConflict<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') throw Errors.conflict('ALREADY_EXISTS', message);
    throw e;
  }
}