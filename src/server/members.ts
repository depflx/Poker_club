import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requireOutlet, requirePerm, requireTenant, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import type { Q } from './db-types';

const { members, owners, cards, wallets } = schema;

/** Loads a member that belongs to the caller's owner. Anything else looks like "not found". */
export async function getMember(q: Q, ctx: Ctx, memberId: string) {
  const ownerId = requireTenant(ctx);
  const [m] = await q.select().from(members).where(and(eq(members.id, memberId), eq(members.ownerId, ownerId)));
  if (!m) throw new AppError('not_found', 'Member not found.');
  return m;
}

const CreateMember = z.object({
  outletId: z.string().uuid(),
  name: z.string().trim().min(2, 'Enter the full name.'),
  mobile: z.string().trim().regex(/^[0-9]{10}$/, 'Mobile must be 10 digits.'),
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  tier: z.enum(['Bronze', 'Silver', 'Gold', 'Platinum']).default('Bronze'),
});

/** Registers an owner-wide member. A member is not tied to a card or to one outlet's wallet. */
export async function createMember(db: DB, ctx: Ctx, raw: z.input<typeof CreateMember>) {
  requirePerm(ctx, 'members.write');
  const ownerId = requireTenant(ctx);
  const input = CreateMember.parse(raw);
  requireOutlet(ctx, input.outletId);
  return db.transaction(async (tx) => {
    await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for('update');
    const [dup] = await tx
      .select()
      .from(members)
      .where(and(eq(members.ownerId, ownerId), eq(members.mobile, input.mobile)));
    if (dup) throw new AppError('conflict', `Mobile already registered to ${dup.name} (${dup.memberNumber}).`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(members).where(eq(members.ownerId, ownerId));
    const [m] = await tx
      .insert(members)
      .values({
        ownerId,
        memberNumber: `M-${1001 + n}`,
        name: input.name,
        mobile: input.mobile,
        email: input.email,
        tier: input.tier,
        homeOutletId: input.outletId,
      })
      .returning();
    await audit(tx, ctx, {
      category: 'Members',
      action: 'Member created',
      entityType: 'member',
      entityId: m.id,
      outletId: input.outletId,
      after: { memberNumber: m.memberNumber, name: m.name, tier: m.tier },
    });
    return m;
  });
}

export interface MemberSearch {
  /** When given, each row also carries that outlet's wallet balance. */
  outletId?: string;
  q?: string;
  status?: 'active' | 'suspended' | 'closed';
  tier?: string;
  limit?: number;
}

/** Search by number, name, mobile or card UID across the owner's members. */
export async function searchMembers(db: DB, ctx: Ctx, f: MemberSearch = {}) {
  requirePerm(ctx, 'members.read');
  const ownerId = requireTenant(ctx);
  const conds = [eq(members.ownerId, ownerId)];
  if (f.status) conds.push(eq(members.status, f.status));
  if (f.tier) conds.push(eq(members.tier, f.tier));
  if (f.q?.trim()) {
    const like = `%${f.q.trim()}%`;
    const byCard = db.select({ id: cards.memberId }).from(cards).where(and(eq(cards.ownerId, ownerId), ilike(cards.uid, like)));
    conds.push(
      or(ilike(members.name, like), ilike(members.mobile, like), ilike(members.memberNumber, like), inArray(members.id, byCard))!,
    );
  }
  const rows = await db.select().from(members).where(and(...conds)).orderBy(members.memberNumber).limit(f.limit ?? 100);
  if (!rows.length) return [];
  const active = await db
    .select()
    .from(cards)
    .where(and(inArray(cards.memberId, rows.map((r) => r.id)), eq(cards.status, 'active')));
  // One outlet's wallet when asked, otherwise the total across every outlet the caller can see.
  const scope = f.outletId ? (requireOutlet(ctx, f.outletId), [f.outletId]) : ctx.outletIds;
  const wl = scope.length
    ? await db
        .select({ memberId: wallets.memberId, balance: wallets.balance })
        .from(wallets)
        .where(and(inArray(wallets.outletId, scope), inArray(wallets.memberId, rows.map((r) => r.id))))
    : [];
  const balances = new Map<string, number>();
  for (const w of wl) balances.set(w.memberId, (balances.get(w.memberId) ?? 0) + w.balance);
  return rows.map((m) => ({
    ...m,
    activeCardUid: active.find((c) => c.memberId === m.id)?.uid ?? null,
    balance: balances.get(m.id) ?? 0,
  }));
}

export async function setMemberStatus(db: DB, ctx: Ctx, memberId: string, status: 'active' | 'suspended' | 'closed', reason: string) {
  requirePerm(ctx, 'members.suspend');
  if (!reason?.trim()) throw new AppError('invalid', 'Give a reason for the status change.');
  return db.transaction(async (tx) => {
    const before = await getMember(tx, ctx, memberId);
    const [after] = await tx.update(members).set({ status }).where(eq(members.id, memberId)).returning();
    await audit(tx, ctx, {
      category: 'Members',
      action: `Member ${status}`,
      entityType: 'member',
      entityId: memberId,
      before: { status: before.status },
      after: { status },
      reason,
    });
    return after;
  });
}

/** Profile for one outlet: cards (all history), this outlet's wallet, and per-outlet balances the caller may see. */
export async function getMemberProfile(db: DB, ctx: Ctx, memberId: string, outletId: string) {
  requirePerm(ctx, 'members.read');
  requireOutlet(ctx, outletId);
  const member = await getMember(db, ctx, memberId);
  const cardHistory = await db.select().from(cards).where(eq(cards.memberId, memberId)).orderBy(desc(cards.createdAt));
  const balances = await db
    .select({ outletId: wallets.outletId, balance: wallets.balance })
    .from(wallets)
    .where(and(eq(wallets.memberId, memberId), inArray(wallets.outletId, ctx.outletIds)));
  return {
    member,
    cards: cardHistory,
    balance: balances.find((b) => b.outletId === outletId)?.balance ?? 0,
    balances,
  };
}
