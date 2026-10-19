import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requireOutlet, requirePerm, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import type { Q, Tx } from './db-types';
import { getMember } from './members';
import { getSettings } from './outlets';

const { wallets, walletLedger, users } = schema;

export type LedgerType = 'recharge' | 'chip_buy_in' | 'chip_return' | 'guest_food' | 'adjustment' | 'reversal';

export interface PostInput {
  outletId: string;
  memberId: string;
  type: LedgerType;
  direction: 'cr' | 'dr';
  amount: number;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  paymentId?: string;
  reversalOfId?: string;
  reason?: string;
  actorId?: string;
}

async function walletFor(tx: Tx, memberId: string, outletId: string) {
  await tx.insert(wallets).values({ memberId, outletId }).onConflictDoNothing();
  const [w] = await tx
    .select()
    .from(wallets)
    .where(and(eq(wallets.memberId, memberId), eq(wallets.outletId, outletId)))
    .for('update');
  return w;
}

/**
 * The single place wallet money moves. Locks the wallet row, enforces balance and idempotency,
 * and writes the ledger line and new balance together. Callers pass their own transaction.
 */
export async function postLedger(tx: Tx, input: PostInput) {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new AppError('invalid', 'Amount must be more than zero.');
  const w = await walletFor(tx, input.memberId, input.outletId);
  const [existing] = await tx
    .select()
    .from(walletLedger)
    .where(and(eq(walletLedger.outletId, input.outletId), eq(walletLedger.idempotencyKey, input.idempotencyKey)));
  if (existing) return { entry: existing, replayed: true };

  const next = w.balance + (input.direction === 'cr' ? input.amount : -input.amount);
  if (next < 0) throw new AppError('low_balance');
  await tx.update(wallets).set({ balance: next, version: w.version + 1 }).where(eq(wallets.id, w.id));
  const [entry] = await tx
    .insert(walletLedger)
    .values({
      walletId: w.id,
      outletId: input.outletId,
      memberId: input.memberId,
      type: input.type,
      direction: input.direction,
      amount: input.amount,
      balanceAfter: next,
      refType: input.refType,
      refId: input.refId,
      paymentId: input.paymentId,
      reversalOfId: input.reversalOfId,
      reason: input.reason,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  return { entry, replayed: false };
}

export async function balanceOf(q: Q, memberId: string, outletId: string): Promise<number> {
  const [w] = await q
    .select()
    .from(wallets)
    .where(and(eq(wallets.memberId, memberId), eq(wallets.outletId, outletId)));
  return w?.balance ?? 0;
}

export async function listLedger(db: DB, ctx: Ctx, memberId: string, outletId: string, opts: { limit?: number; offset?: number } = {}) {
  requirePerm(ctx, 'wallet.read');
  requireOutlet(ctx, outletId);
  await getMember(db, ctx, memberId);
  return db
    .select()
    .from(walletLedger)
    .where(and(eq(walletLedger.memberId, memberId), eq(walletLedger.outletId, outletId)))
    .orderBy(desc(walletLedger.createdAt), desc(walletLedger.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

const Adjust = z.object({
  outletId: z.string().uuid(),
  memberId: z.string().uuid(),
  direction: z.enum(['cr', 'dr']),
  amount: z.number().int().positive(),
  reason: z.string().trim().min(3, 'Give a reason for the adjustment.'),
  idempotencyKey: z.string().min(8),
  /** Another owner-level user who approves an amount above the outlet threshold. */
  secondApproverId: z.string().uuid().optional(),
});

/** Manual correction. Posts a new ledger line; nothing already posted is edited. */
export async function adjustWallet(db: DB, ctx: Ctx, raw: z.input<typeof Adjust>) {
  requirePerm(ctx, 'wallet.adjust');
  const input = Adjust.parse(raw);
  requireOutlet(ctx, input.outletId);
  const settings = await getSettings(db, ctx, input.outletId);
  return db.transaction(async (tx) => {
    const member = await getMember(tx, ctx, input.memberId);
    if (input.amount > settings.approvalThreshold) {
      const [approver] = input.secondApproverId
        ? await tx.select().from(users).where(eq(users.id, input.secondApproverId))
        : [];
      if (!approver || approver.id === ctx.userId || approver.ownerId !== ctx.ownerId || approver.role !== 'owner' || approver.status !== 'active') {
        throw new AppError('invalid', 'This amount needs approval from a second owner account.');
      }
    }
    const { entry, replayed } = await postLedger(tx, {
      outletId: input.outletId,
      memberId: member.id,
      type: 'adjustment',
      direction: input.direction,
      amount: input.amount,
      reason: input.reason,
      actorId: ctx.userId,
      idempotencyKey: `adjust:${input.idempotencyKey}`,
    });
    if (!replayed) {
      await audit(tx, ctx, {
        category: 'Wallet',
        action: input.direction === 'cr' ? 'Manual adjustment credit' : 'Manual adjustment debit',
        entityType: 'wallet_ledger',
        entityId: entry.id,
        outletId: input.outletId,
        after: { memberId: member.id, amount: input.amount, balanceAfter: entry.balanceAfter, approver: input.secondApproverId ?? null },
        reason: input.reason,
      });
    }
    return entry;
  });
}

/** Undoes one posted line with an equal and opposite line. A line can be reversed once. */
export async function reverseEntry(db: DB, ctx: Ctx, ledgerId: string, reason: string) {
  requirePerm(ctx, 'wallet.adjust');
  if (!reason?.trim()) throw new AppError('invalid', 'Give a reason for the reversal.');
  return db.transaction(async (tx) => {
    const [orig] = await tx.select().from(walletLedger).where(eq(walletLedger.id, ledgerId));
    if (!orig) throw new AppError('not_found', 'Ledger entry not found.');
    requireOutlet(ctx, orig.outletId);
    await getMember(tx, ctx, orig.memberId);
    if (orig.type === 'reversal') throw new AppError('invalid', 'A reversal cannot be reversed.');
    const [already] = await tx.select().from(walletLedger).where(eq(walletLedger.reversalOfId, ledgerId));
    if (already) throw new AppError('conflict', 'This entry has already been reversed.');
    const { entry } = await postLedger(tx, {
      outletId: orig.outletId,
      memberId: orig.memberId,
      type: 'reversal',
      direction: orig.direction === 'cr' ? 'dr' : 'cr',
      amount: orig.amount,
      reversalOfId: orig.id,
      reason,
      actorId: ctx.userId,
      idempotencyKey: `reversal:${orig.id}`,
    });
    await audit(tx, ctx, {
      category: 'Wallet',
      action: 'Ledger entry reversed',
      entityType: 'wallet_ledger',
      entityId: orig.id,
      outletId: orig.outletId,
      after: { reversalId: entry.id, amount: orig.amount },
      reason,
    });
    return entry;
  });
}
