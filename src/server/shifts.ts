import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requireOutlet, requirePerm, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import type { Q } from './db-types';

const { shifts, payments, users } = schema;

export type Shift = typeof shifts.$inferSelect;
export type MethodTotals = { cash: number; card: number; upi: number };

/** What the till should hold: opening float plus cash taken, and confirmed card and UPI totals. Pending UPI is excluded. */
export async function expectedTotals(q: Q, shift: Shift): Promise<MethodTotals> {
  const rows = await q
    .select()
    .from(payments)
    .where(and(eq(payments.shiftId, shift.id), eq(payments.status, 'confirmed')));
  const sum = (m: string) => rows.filter((p) => p.method === m).reduce((a, p) => a + p.amount, 0);
  return { cash: shift.openingCash + sum('cash'), card: sum('card'), upi: sum('upi') };
}

export async function openShift(db: DB, ctx: Ctx, input: { outletId: string; openingCash: number }) {
  requirePerm(ctx, 'shift.run');
  requireOutlet(ctx, input.outletId);
  if (!Number.isInteger(input.openingCash) || input.openingCash < 0) throw new AppError('invalid', 'Opening cash cannot be negative.');
  return db.transaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(shifts)
      .where(and(eq(shifts.outletId, input.outletId), eq(shifts.cashierId, ctx.userId), eq(shifts.status, 'open')));
    if (open) throw new AppError('conflict', 'You already have an open shift at this outlet.');
    const [shift] = await tx
      .insert(shifts)
      .values({ outletId: input.outletId, cashierId: ctx.userId, openingCash: input.openingCash })
      .returning();
    await audit(tx, ctx, {
      category: 'Shifts', action: 'Shift opened', entityType: 'shift', entityId: shift.id,
      outletId: input.outletId, after: { openingCash: input.openingCash },
    });
    return shift;
  });
}

export async function currentShift(db: DB, ctx: Ctx, outletId: string) {
  requirePerm(ctx, 'shift.run');
  requireOutlet(ctx, outletId);
  const [s] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.outletId, outletId), eq(shifts.cashierId, ctx.userId), eq(shifts.status, 'open')));
  if (!s) return null;
  return { shift: s, expected: await expectedTotals(db, s) };
}

const Close = z.object({
  counted: z.object({ cash: z.number().int().min(0), card: z.number().int().min(0), upi: z.number().int().min(0) }),
  note: z.string().trim().optional(),
});

/** Records what was counted against what was expected. Differences are reported, never forced to match. */
export async function closeShift(db: DB, ctx: Ctx, shiftId: string, raw: z.input<typeof Close>) {
  requirePerm(ctx, 'shift.run');
  const input = Close.parse(raw);
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).for('update');
    if (!s) throw new AppError('not_found', 'Shift not found.');
    requireOutlet(ctx, s.outletId);
    if (s.cashierId !== ctx.userId && ctx.role !== 'owner') throw new AppError('forbidden', 'You can only close your own shift.');
    if (s.status !== 'open') throw new AppError('conflict', 'This shift is already closed.');
    const expected = await expectedTotals(tx, s);
    const diff = {
      cash: input.counted.cash - expected.cash,
      card: input.counted.card - expected.card,
      upi: input.counted.upi - expected.upi,
    };
    const discrepancy = diff.cash + diff.card + diff.upi;
    const anyDiff = diff.cash !== 0 || diff.card !== 0 || diff.upi !== 0;
    if (anyDiff && !input.note) throw new AppError('invalid', 'Add a note explaining the difference.');
    const [after] = await tx
      .update(shifts)
      .set({ status: 'review', closedAt: new Date(), expected, counted: input.counted, discrepancy, note: input.note ?? null })
      .where(eq(shifts.id, shiftId))
      .returning();
    await audit(tx, ctx, {
      category: 'Shifts', action: 'Shift submitted for review', entityType: 'shift', entityId: shiftId,
      outletId: s.outletId, after: { expected, counted: input.counted, discrepancy }, reason: input.note,
    });
    return after;
  });
}

/** Owner locks a reviewed shift. Later corrections are posted as wallet adjustments instead. */
export async function approveShift(db: DB, ctx: Ctx, shiftId: string, note?: string) {
  requirePerm(ctx, 'shift.approve');
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).for('update');
    if (!s) throw new AppError('not_found', 'Shift not found.');
    requireOutlet(ctx, s.outletId);
    if (s.status !== 'review') throw new AppError('conflict', 'Only a submitted shift can be approved.');
    const [after] = await tx
      .update(shifts)
      .set({ status: 'approved', reviewerId: ctx.userId, reviewNote: note ?? null })
      .where(eq(shifts.id, shiftId))
      .returning();
    await audit(tx, ctx, {
      category: 'Shifts', action: 'Shift approved and locked', entityType: 'shift', entityId: shiftId,
      outletId: s.outletId, before: { status: 'review' }, after: { status: 'approved', discrepancy: s.discrepancy }, reason: note,
    });
    return after;
  });
}

/** Sends a submitted shift back to the cashier to recount. */
export async function rejectShift(db: DB, ctx: Ctx, shiftId: string, reason: string) {
  requirePerm(ctx, 'shift.approve');
  if (!reason?.trim()) throw new AppError('invalid', 'Say what should be rechecked.');
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).for('update');
    if (!s) throw new AppError('not_found', 'Shift not found.');
    requireOutlet(ctx, s.outletId);
    if (s.status !== 'review') throw new AppError('conflict', 'Only a submitted shift can be sent back.');
    const [after] = await tx
      .update(shifts)
      .set({ status: 'open', closedAt: null, reviewerId: ctx.userId, reviewNote: reason })
      .where(eq(shifts.id, shiftId))
      .returning();
    await audit(tx, ctx, {
      category: 'Shifts', action: 'Shift sent back to cashier', entityType: 'shift', entityId: shiftId,
      outletId: s.outletId, before: { status: 'review' }, after: { status: 'open' }, reason,
    });
    return after;
  });
}

export async function listShifts(db: DB, ctx: Ctx, outletId: string, status?: Shift['status']) {
  requirePerm(ctx, 'shift.approve');
  requireOutlet(ctx, outletId);
  const conds = [eq(shifts.outletId, outletId)];
  if (status) conds.push(eq(shifts.status, status));
  return db
    .select({ shift: shifts, cashier: users.name })
    .from(shifts)
    .innerJoin(users, eq(users.id, shifts.cashierId))
    .where(and(...conds))
    .orderBy(desc(shifts.openedAt));
}

/** A cashier's own recent shifts, newest first. */
export async function myShifts(db: DB, ctx: Ctx, outletId: string, limit = 5) {
  requirePerm(ctx, 'shift.run');
  requireOutlet(ctx, outletId);
  return db
    .select()
    .from(shifts)
    .where(and(eq(shifts.outletId, outletId), eq(shifts.cashierId, ctx.userId)))
    .orderBy(desc(shifts.openedAt))
    .limit(limit);
}
