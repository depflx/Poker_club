import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { requireOutlet, requirePerm, requireTenant, type Ctx } from '@/lib/permissions';

const { payments, wallets, walletLedger, chipTransactions, pokerSessions, pokerTables, sessionPlayers, shifts, outlets, cards, members } = schema;

export interface Books {
  outletId: string;
  /** Money actually received and confirmed at the counter. Not revenue. */
  collected: { total: number; cash: number; upi: number; card: number; recharge: number; cardIssue: number; cardReplacement: number };
  /** UPI attempts not yet confirmed. Excluded from everything else. */
  awaitingConfirmation: number;
  /** Fees for cards. Never credited to a wallet. */
  feesCollected: number;
  /** Chargeable guest food posted to wallets, net of reversals. Player food is always zero. */
  guestFoodCharged: number;
  /** What the club owes members in unspent wallet balance at this outlet. */
  walletLiability: number;
  /** Physical chips issued and not returned in sessions still running. */
  chipsOutstanding: number;
  /** Deliberately empty until the club defines revenue. */
  revenue: null;
}

export interface Range { from?: Date; to?: Date }

async function booksFor(db: DB, outletId: string, range: Range): Promise<Books> {
  const pay = [eq(payments.outletId, outletId)];
  if (range.from) pay.push(gte(payments.createdAt, range.from));
  if (range.to) pay.push(lt(payments.createdAt, range.to));
  const rows = await db.select().from(payments).where(and(...pay));
  const done = rows.filter((p) => p.status === 'confirmed');
  const sum = (f: (p: (typeof rows)[number]) => boolean) => done.filter(f).reduce((a, p) => a + p.amount, 0);

  const [liab] = await db
    .select({ n: sql<number>`coalesce(sum(${wallets.balance}), 0)::bigint` })
    .from(wallets)
    .where(eq(wallets.outletId, outletId));

  const led = [eq(walletLedger.outletId, outletId)];
  if (range.from) led.push(gte(walletLedger.createdAt, range.from));
  if (range.to) led.push(lt(walletLedger.createdAt, range.to));
  const food = await db.select().from(walletLedger).where(and(...led, eq(walletLedger.type, 'guest_food')));
  const foodReversed = await db
    .select({ r: walletLedger })
    .from(walletLedger)
    .where(and(eq(walletLedger.outletId, outletId), eq(walletLedger.type, 'reversal'), inArray(walletLedger.reversalOfId, food.length ? food.map((f) => f.id) : ['00000000-0000-0000-0000-000000000000'])));

  const open = await db
    .select({ id: pokerSessions.id })
    .from(pokerSessions)
    .where(and(eq(pokerSessions.outletId, outletId), eq(pokerSessions.status, 'in_progress')));
  let chips = 0;
  if (open.length) {
    const rowsC = await db.select().from(chipTransactions).where(inArray(chipTransactions.sessionId, open.map((s) => s.id)));
    chips = rowsC.reduce((a, c) => a + (c.type === 'issue' ? c.amount : -c.amount), 0);
  }

  const cardIssue = sum((p) => p.purpose === 'card_issue');
  const cardReplacement = sum((p) => p.purpose === 'card_replacement');
  return {
    outletId,
    collected: {
      total: sum(() => true),
      cash: sum((p) => p.method === 'cash'),
      upi: sum((p) => p.method === 'upi'),
      card: sum((p) => p.method === 'card'),
      recharge: sum((p) => p.purpose === 'recharge'),
      cardIssue,
      cardReplacement,
    },
    awaitingConfirmation: rows.filter((p) => p.status === 'pending').reduce((a, p) => a + p.amount, 0),
    feesCollected: cardIssue + cardReplacement,
    guestFoodCharged: food.reduce((a, f) => a + f.amount, 0) - foodReversed.reduce((a, f) => a + f.r.amount, 0),
    walletLiability: Number(liab.n),
    chipsOutstanding: chips,
    revenue: null,
  };
}

/** One outlet's books. Each figure is kept separate and labelled by what it is. */
export async function outletBooks(db: DB, ctx: Ctx, outletId: string, range: Range = {}) {
  requirePerm(ctx, 'reports.read');
  requireOutlet(ctx, outletId);
  return booksFor(db, outletId, range);
}

/**
 * All of an owner's outlets: a breakdown per outlet and combined totals.
 * Wallet liability is summed for convenience, but each outlet's own figure stays visible.
 */
export async function ownerRollup(db: DB, ctx: Ctx, range: Range = {}) {
  requirePerm(ctx, 'reports.read');
  requireTenant(ctx);
  const list = ctx.outletIds.length
    ? await db.select().from(outlets).where(inArray(outlets.id, ctx.outletIds)).orderBy(outlets.createdAt)
    : [];
  const perOutlet: { outlet: (typeof list)[number]; books: Books }[] = [];
  for (const o of list) perOutlet.push({ outlet: o, books: await booksFor(db, o.id, range) });
  const add = (f: (b: Books) => number) => perOutlet.reduce((a, p) => a + f(p.books), 0);
  return {
    perOutlet,
    totals: {
      collected: add((b) => b.collected.total),
      awaitingConfirmation: add((b) => b.awaitingConfirmation),
      feesCollected: add((b) => b.feesCollected),
      guestFoodCharged: add((b) => b.guestFoodCharged),
      walletLiability: add((b) => b.walletLiability),
      chipsOutstanding: add((b) => b.chipsOutstanding),
    },
    revenue: null as null,
  };
}

/** Live floor across outlets: tables in play and players seated. */
export async function floorOverview(db: DB, ctx: Ctx, outletId?: string) {
  requirePerm(ctx, 'reports.read');
  const ids = outletId ? (requireOutlet(ctx, outletId), [outletId]) : ctx.outletIds;
  if (!ids.length) return [];
  const tables = await db.select().from(pokerTables).where(inArray(pokerTables.outletId, ids)).orderBy(pokerTables.name);
  const open = await db
    .select()
    .from(pokerSessions)
    .where(and(inArray(pokerSessions.outletId, ids), eq(pokerSessions.status, 'in_progress')));
  const seated = open.length
    ? await db
        .select()
        .from(sessionPlayers)
        .where(and(inArray(sessionPlayers.sessionId, open.map((s) => s.id)), eq(sessionPlayers.status, 'active')))
    : [];
  return tables.map((t) => {
    const s = open.find((x) => x.tableId === t.id);
    return {
      outletId: t.outletId,
      tableId: t.id,
      name: t.name,
      inPlay: !!s,
      seats: s ? seated.filter((p) => p.sessionId === s.id).map((p) => p.seatNumber) : [],
      maxSeats: t.maxSeats,
    };
  });
}

/** What needs the owner today: shifts to approve, UPI payments hanging, chip exceptions unresolved. */
export async function decisionQueue(db: DB, ctx: Ctx, outletId?: string) {
  requirePerm(ctx, 'reports.read');
  const ids = outletId ? (requireOutlet(ctx, outletId), [outletId]) : ctx.outletIds;
  if (!ids.length) return { shifts: [], pendingPayments: [], chipExceptions: [] };
  const awaiting = await db
    .select({ shift: shifts, cashier: schema.users.name })
    .from(shifts)
    .innerJoin(schema.users, eq(schema.users.id, shifts.cashierId))
    .where(and(inArray(shifts.outletId, ids), eq(shifts.status, 'review')));
  const pending = await db
    .select({ payment: payments, memberName: members.name })
    .from(payments)
    .innerJoin(members, eq(members.id, payments.memberId))
    .where(and(inArray(payments.outletId, ids), eq(payments.status, 'pending')));
  const exceptions = await db
    .select()
    .from(pokerSessions)
    .where(and(inArray(pokerSessions.outletId, ids), eq(pokerSessions.status, 'completed'), isNull(pokerSessions.exceptionResolvedAt), sql`${pokerSessions.exceptionAmount} > 0`));
  return { shifts: awaiting, pendingPayments: pending, chipExceptions: exceptions };
}

/** Counts cards by status for the owner dashboard. */
export async function cardCounts(db: DB, ctx: Ctx) {
  requirePerm(ctx, 'reports.read');
  const ownerId = requireTenant(ctx);
  const rows = await db
    .select({ status: cards.status, n: sql<number>`count(*)::int` })
    .from(cards)
    .where(eq(cards.ownerId, ownerId))
    .groupBy(cards.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
}


/** Latest wallet postings at an outlet, newest first, with the member's name and a readable reference. */
export async function recentLedger(db: DB, ctx: Ctx, outletId: string, limit = 25) {
  requirePerm(ctx, 'reports.read');
  requireOutlet(ctx, outletId);
  const rows = await db
    .select({ entry: walletLedger, memberName: members.name, memberNumber: members.memberNumber })
    .from(walletLedger)
    .innerJoin(members, eq(members.id, walletLedger.memberId))
    .where(eq(walletLedger.outletId, outletId))
    .orderBy(desc(walletLedger.createdAt), desc(walletLedger.id))
    .limit(limit);
  const sessionIds = [...new Set(rows.filter((r) => r.entry.refType === 'session' && r.entry.refId).map((r) => r.entry.refId!))];
  const tables = sessionIds.length
    ? await db
        .select({ id: pokerSessions.id, name: pokerTables.name })
        .from(pokerSessions)
        .innerJoin(pokerTables, eq(pokerTables.id, pokerSessions.tableId))
        .where(inArray(pokerSessions.id, sessionIds))
    : [];
  return rows.map((r) => ({
    ...r,
    reference:
      r.entry.refType === 'session'
        ? (tables.find((t) => t.id === r.entry.refId)?.name ?? 'Table session')
        : (r.entry.reason ?? r.entry.refId ?? '—'),
  }));
}
