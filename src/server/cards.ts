import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requireOutlet, requirePerm, requireTenant, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import type { Q, Tx } from './db-types';
import { getMember } from './members';
import { getSettings } from './outlets';
import { createPayment } from './payments';

const { cards, members, payments } = schema;

export const normUid = (uid: string) => uid.trim().toUpperCase();

/**
 * Resolves a tapped card for a protected action (seating, chips, food, wallet).
 * Unknown, blocked, replaced and suspended-member cards all fail with the PRD wording.
 */
export async function lookupCard(q: Q, ctx: Ctx, rawUid: string) {
  const ownerId = requireTenant(ctx);
  const [card] = await q.select().from(cards).where(and(eq(cards.uid, normUid(rawUid)), eq(cards.ownerId, ownerId)));
  if (!card || card.status === 'unassigned' || !card.memberId) throw new AppError('unknown_card');
  if (card.status !== 'active') throw new AppError('blocked_card');
  const [member] = await q.select().from(members).where(eq(members.id, card.memberId));
  if (member.status !== 'active') throw new AppError('blocked_card', 'This member is not active. Please visit the counter.');
  return { card, member };
}

type FeeInput = { method?: 'cash' | 'card' | 'upi'; paymentId?: string };

/** Collects the card fee: either a fresh cash/card payment, or a confirmed payment already taken (for UPI). */
async function collectFee(tx: Tx, ctx: Ctx, args: {
  outletId: string; memberId: string; fee: number; purpose: 'card_issue' | 'card_replacement'; key: string;
} & FeeInput): Promise<string | null> {
  if (args.fee <= 0) return null;
  if (args.paymentId) {
    const [p] = await tx.select().from(payments).where(eq(payments.id, args.paymentId)).for('update');
    if (!p || p.memberId !== args.memberId || p.outletId !== args.outletId || p.purpose !== args.purpose) {
      throw new AppError('invalid', 'That payment does not match this card fee.');
    }
    if (p.status !== 'confirmed') throw new AppError('payment_pending');
    if (p.cardId) throw new AppError('conflict', 'That payment has already been used for a card.');
    if (p.amount < args.fee) throw new AppError('invalid', 'That payment is less than the card fee.');
    return p.id;
  }
  if (!args.method) throw new AppError('invalid', 'Collect the card fee first.');
  const { payment } = await createPayment(tx, ctx, {
    outletId: args.outletId,
    memberId: args.memberId,
    amount: args.fee,
    method: args.method,
    purpose: args.purpose,
    idempotencyKey: `card-fee:${args.key}`,
  });
  if (payment.status !== 'confirmed') throw new AppError('payment_pending', 'Payment is pending confirmation. The card has not been issued.');
  return payment.id;
}

async function claimNewCard(tx: Tx, ownerId: string, uid: string) {
  const [existing] = await tx.select().from(cards).where(eq(cards.uid, uid)).for('update');
  if (existing) {
    if (existing.memberId || existing.ownerId !== ownerId) throw new AppError('duplicate_card');
    if (existing.status !== 'unassigned') throw new AppError('blocked_card');
  }
  return existing;
}

const Issue = z.object({
  outletId: z.string().uuid(),
  memberId: z.string().uuid(),
  uid: z.string().trim().min(4, 'Tap or enter the card ID.'),
  method: z.enum(['cash', 'card', 'upi']).optional(),
  paymentId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8),
});

async function activate(tx: Tx, ctx: Ctx, args: { existing?: typeof cards.$inferSelect; uid: string; memberId: string; outletId: string }) {
  const values = {
    ownerId: ctx.ownerId!,
    uid: args.uid,
    memberId: args.memberId,
    status: 'active',
    issuedOutletId: args.outletId,
    issuedBy: ctx.userId,
    issuedAt: new Date(),
  };
  if (args.existing) {
    const [c] = await tx.update(cards).set(values).where(eq(cards.id, args.existing.id)).returning();
    return c;
  }
  const [c] = await tx.insert(cards).values(values).returning();
  return c;
}

/** Links a card to a member after the fee is collected. The card is active only when every step succeeded. */
export async function issueCard(db: DB, ctx: Ctx, raw: z.input<typeof Issue>) {
  requirePerm(ctx, 'cards.manage');
  const ownerId = requireTenant(ctx);
  const input = Issue.parse(raw);
  requireOutlet(ctx, input.outletId);
  const uid = normUid(input.uid);
  const settings = await getSettings(db, ctx, input.outletId);
  return db.transaction(async (tx) => {
    const member = await getMember(tx, ctx, input.memberId);
    if (member.status !== 'active') throw new AppError('invalid', 'This member is not active.');
    // A retried request for the card that is already active returns it instead of failing.
    const [mine] = await tx.select().from(cards).where(and(eq(cards.uid, uid), eq(cards.memberId, member.id), eq(cards.status, 'active')));
    if (mine) return mine;
    const existing = await claimNewCard(tx, ownerId, uid);
    const [current] = await tx.select().from(cards).where(and(eq(cards.memberId, member.id), eq(cards.status, 'active')));
    if (current) throw new AppError('conflict', 'This member already has an active card. Replace it instead.');
    const paymentId = await collectFee(tx, ctx, {
      outletId: input.outletId, memberId: member.id, fee: settings.issueFee, purpose: 'card_issue',
      key: input.idempotencyKey, method: input.method, paymentId: input.paymentId,
    });
    const card = await activate(tx, ctx, { existing, uid, memberId: member.id, outletId: input.outletId });
    if (paymentId) await tx.update(payments).set({ cardId: card.id }).where(eq(payments.id, paymentId));
    await audit(tx, ctx, {
      category: 'Cards',
      action: 'Card issued',
      entityType: 'card',
      entityId: card.id,
      outletId: input.outletId,
      after: { uid, memberId: member.id, paymentId },
    });
    return card;
  });
}

/** Blocks a card as lost or damaged. It stays in history and can never be reactivated. */
export async function blockCard(db: DB, ctx: Ctx, input: { cardId: string; reason: string; kind?: 'lost' | 'damaged' }) {
  requirePerm(ctx, 'cards.manage');
  const ownerId = requireTenant(ctx);
  if (!input.reason?.trim()) throw new AppError('invalid', 'Give a reason for blocking the card.');
  return db.transaction(async (tx) => {
    const [card] = await tx.select().from(cards).where(and(eq(cards.id, input.cardId), eq(cards.ownerId, ownerId))).for('update');
    if (!card) throw new AppError('not_found', 'Card not found.');
    if (card.status !== 'active') throw new AppError('conflict', 'Only an active card can be blocked.');
    const [after] = await tx
      .update(cards)
      .set({ status: input.kind ?? 'lost', reason: input.reason, blockedAt: new Date() })
      .where(eq(cards.id, card.id))
      .returning();
    await audit(tx, ctx, {
      category: 'Cards',
      action: 'Card blocked',
      entityType: 'card',
      entityId: card.id,
      before: { status: card.status },
      after: { status: after.status },
      reason: input.reason,
    });
    return after;
  });
}

const Replace = z.object({
  outletId: z.string().uuid(),
  memberId: z.string().uuid(),
  newUid: z.string().trim().min(4, 'Tap or enter the new card ID.'),
  /** Used only if the member's current card is still active: it is blocked as part of the replacement. */
  reason: z.string().trim().optional(),
  method: z.enum(['cash', 'card', 'upi']).optional(),
  paymentId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8),
});

/** Gives the same member a new card. Profile, wallet and history are untouched; the fee never reaches the wallet. */
export async function replaceCard(db: DB, ctx: Ctx, raw: z.input<typeof Replace>) {
  requirePerm(ctx, 'cards.manage');
  const ownerId = requireTenant(ctx);
  const input = Replace.parse(raw);
  requireOutlet(ctx, input.outletId);
  const uid = normUid(input.newUid);
  const settings = await getSettings(db, ctx, input.outletId);
  return db.transaction(async (tx) => {
    const member = await getMember(tx, ctx, input.memberId);
    if (member.status !== 'active') throw new AppError('invalid', 'This member is not active.');
    // A retried request for the card that is already active returns it instead of failing.
    const [mine] = await tx.select().from(cards).where(and(eq(cards.uid, uid), eq(cards.memberId, member.id), eq(cards.status, 'active')));
    if (mine) return mine;
    const history = await tx.select().from(cards).where(eq(cards.memberId, member.id)).for('update');
    if (!history.length) throw new AppError('invalid', 'This member has no card to replace. Issue a card instead.');
    const existing = await claimNewCard(tx, ownerId, uid);

    const active = history.find((c) => c.status === 'active');
    if (active) {
      if (!input.reason) throw new AppError('invalid', 'Give a reason for blocking the current card.');
      await tx.update(cards).set({ status: 'lost', reason: input.reason, blockedAt: new Date() }).where(eq(cards.id, active.id));
      await audit(tx, ctx, {
        category: 'Cards', action: 'Card blocked', entityType: 'card', entityId: active.id,
        before: { status: 'active' }, after: { status: 'lost' }, reason: input.reason,
      });
    }
    const paymentId = await collectFee(tx, ctx, {
      outletId: input.outletId, memberId: member.id, fee: settings.replacementFee, purpose: 'card_replacement',
      key: input.idempotencyKey, method: input.method, paymentId: input.paymentId,
    });
    const card = await activate(tx, ctx, { existing, uid, memberId: member.id, outletId: input.outletId });
    if (paymentId) await tx.update(payments).set({ cardId: card.id }).where(eq(payments.id, paymentId));
    for (const old of history.filter((c) => c.status === 'lost' || c.status === 'damaged' || c.id === active?.id)) {
      await tx.update(cards).set({ status: 'replaced', replacedByCardId: card.id }).where(eq(cards.id, old.id));
    }
    await audit(tx, ctx, {
      category: 'Cards',
      action: 'Card replaced',
      entityType: 'card',
      entityId: card.id,
      outletId: input.outletId,
      after: { newUid: uid, memberId: member.id, paymentId, replaced: history.filter((c) => c.status !== 'replaced').map((c) => c.uid) },
    });
    return card;
  });
}
