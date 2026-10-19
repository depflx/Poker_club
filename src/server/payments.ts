import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requireOutlet, requirePerm, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import type { Tx } from './db-types';
import { getMember } from './members';
import { postLedger } from './wallet';

const { payments, outlets, shifts, members, users } = schema;

export type Payment = typeof payments.$inferSelect;

async function nextReceiptNo(tx: Tx, outletId: string) {
  const [o] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).for('update');
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(payments).where(eq(payments.outletId, outletId));
  return `R-${o.code}-${String(n + 1).padStart(5, '0')}`;
}

/** Cashiers must have an open shift so every rupee they take lands in a reconcilable shift. */
async function shiftFor(tx: Tx, ctx: Ctx, outletId: string): Promise<string | null> {
  if (ctx.role !== 'cashier') return null;
  const [s] = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.outletId, outletId), eq(shifts.cashierId, ctx.userId), eq(shifts.status, 'open')));
  if (!s) throw new AppError('invalid', 'Open a shift before taking payments.');
  return s.id;
}

const Record = z.object({
  outletId: z.string().uuid(),
  memberId: z.string().uuid(),
  amount: z.number().int().positive('Enter an amount above zero.'),
  method: z.enum(['cash', 'upi', 'card']),
  purpose: z.enum(['recharge', 'card_issue', 'card_replacement']),
  idempotencyKey: z.string().min(8),
});
export type RecordPaymentInput = z.input<typeof Record>;

/** Wallet effect of a confirmed payment. Only recharges touch the wallet, and only once. */
async function applyConfirmed(tx: Tx, ctx: Ctx, p: Payment) {
  if (p.purpose !== 'recharge') return;
  await postLedger(tx, {
    outletId: p.outletId,
    memberId: p.memberId,
    type: 'recharge',
    direction: 'cr',
    amount: p.amount,
    refType: 'payment',
    refId: p.receiptNo,
    paymentId: p.id,
    actorId: ctx.userId,
    idempotencyKey: `pay:${p.id}`,
  });
}

/** Creates a payment inside a caller's transaction. Cash and card confirm at once; UPI waits for confirmation. */
export async function createPayment(tx: Tx, ctx: Ctx, raw: RecordPaymentInput) {
  const input = Record.parse(raw);
  requireOutlet(ctx, input.outletId);
  await getMember(tx, ctx, input.memberId);
  const [existing] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.outletId, input.outletId), eq(payments.idempotencyKey, input.idempotencyKey)));
  if (existing) return { payment: existing, replayed: true };

  const shiftId = await shiftFor(tx, ctx, input.outletId);
  const confirmedNow = input.method !== 'upi';
  const [payment] = await tx
    .insert(payments)
    .values({
      outletId: input.outletId,
      memberId: input.memberId,
      receiptNo: await nextReceiptNo(tx, input.outletId),
      amount: input.amount,
      method: input.method,
      purpose: input.purpose,
      status: confirmedNow ? 'confirmed' : 'pending',
      confirmedAt: confirmedNow ? new Date() : null,
      cashierId: ctx.userId,
      shiftId,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  if (confirmedNow) await applyConfirmed(tx, ctx, payment);
  await audit(tx, ctx, {
    category: 'Wallet',
    action: confirmedNow ? 'Payment recorded' : 'Payment pending confirmation',
    entityType: 'payment',
    entityId: payment.id,
    outletId: input.outletId,
    after: { receiptNo: payment.receiptNo, amount: payment.amount, method: payment.method, purpose: payment.purpose },
  });
  return { payment, replayed: false };
}

export async function recordPayment(db: DB, ctx: Ctx, raw: RecordPaymentInput) {
  requirePerm(ctx, 'payments.record');
  return db.transaction((tx) => createPayment(tx, ctx, raw));
}

/** Staff confirm a pending UPI payment (V1 has no gateway). A repeat confirm changes nothing. */
export async function confirmPayment(db: DB, ctx: Ctx, paymentId: string, input: { gatewayRef?: string } = {}) {
  requirePerm(ctx, 'payments.confirm');
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
    if (!p) throw new AppError('not_found', 'Payment not found.');
    requireOutlet(ctx, p.outletId);
    await getMember(tx, ctx, p.memberId);
    if (p.status === 'confirmed') return { payment: p, replayed: true };
    if (p.status === 'failed') throw new AppError('conflict', 'This payment was marked failed.');
    if (p.method === 'upi' && !input.gatewayRef?.trim()) throw new AppError('invalid', 'Enter the UPI transaction reference to confirm.');
    const [payment] = await tx
      .update(payments)
      .set({ status: 'confirmed', confirmedAt: new Date(), gatewayRef: input.gatewayRef?.trim() ?? p.gatewayRef })
      .where(eq(payments.id, paymentId))
      .returning();
    await applyConfirmed(tx, ctx, payment);
    await audit(tx, ctx, {
      category: 'Wallet',
      action: 'Payment confirmed',
      entityType: 'payment',
      entityId: p.id,
      outletId: p.outletId,
      before: { status: p.status },
      after: { status: 'confirmed', gatewayRef: payment.gatewayRef },
    });
    return { payment, replayed: false };
  });
}

export async function failPayment(db: DB, ctx: Ctx, paymentId: string, reason: string) {
  requirePerm(ctx, 'payments.confirm');
  if (!reason?.trim()) throw new AppError('invalid', 'Give a reason.');
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
    if (!p) throw new AppError('not_found', 'Payment not found.');
    requireOutlet(ctx, p.outletId);
    if (p.status !== 'pending') throw new AppError('conflict', 'Only a pending payment can be marked failed.');
    const [payment] = await tx.update(payments).set({ status: 'failed' }).where(eq(payments.id, paymentId)).returning();
    await audit(tx, ctx, {
      category: 'Wallet',
      action: 'Payment marked failed',
      entityType: 'payment',
      entityId: p.id,
      outletId: p.outletId,
      reason,
    });
    return payment;
  });
}

export async function listPayments(db: DB, ctx: Ctx, outletId: string, f: { status?: string; limit?: number } = {}) {
  requirePerm(ctx, 'payments.record');
  requireOutlet(ctx, outletId);
  const conds = [eq(payments.outletId, outletId)];
  if (f.status) conds.push(eq(payments.status, f.status));
  return db
    .select({ payment: payments, memberName: members.name, memberNumber: members.memberNumber })
    .from(payments)
    .innerJoin(members, eq(members.id, payments.memberId))
    .where(and(...conds))
    .orderBy(desc(payments.createdAt))
    .limit(f.limit ?? 50);
}

export async function getReceipt(db: DB, ctx: Ctx, paymentId: string) {
  requirePerm(ctx, 'payments.record');
  const [row] = await db
    .select({ payment: payments, member: members, cashier: users.name, outlet: outlets.name })
    .from(payments)
    .innerJoin(members, eq(members.id, payments.memberId))
    .innerJoin(users, eq(users.id, payments.cashierId))
    .innerJoin(outlets, eq(outlets.id, payments.outletId))
    .where(eq(payments.id, paymentId));
  if (!row) throw new AppError('not_found', 'Receipt not found.');
  requireOutlet(ctx, row.payment.outletId);
  await getMember(db, ctx, row.member.id);
  return {
    receiptNo: row.payment.receiptNo,
    outlet: row.outlet,
    memberNumber: row.member.memberNumber,
    memberName: row.member.name,
    purpose: row.payment.purpose,
    amount: row.payment.amount,
    method: row.payment.method,
    status: row.payment.status,
    cashier: row.cashier,
    at: row.payment.createdAt,
  };
}
