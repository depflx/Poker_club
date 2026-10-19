import { beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '@/server/audit';
import { addMenuItem } from '@/server/food';
import { searchMembers } from '@/server/members';
import { createTable, issueChips, openSession, seatPlayer, tablesBoard } from '@/server/poker';
import { recordPayment } from '@/server/payments';
import { cardCounts, decisionQueue, floorOverview, outletBooks, ownerRollup } from '@/server/reports';
import { closeShift, currentShift, openShift } from '@/server/shifts';
import { balanceOf, adjustWallet } from '@/server/wallet';
import { rupees } from '@/lib/money';
import { errorOf, fund, key, mkPlayer, world, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
  await openShift(w.db, w.staffA.cashier, { outletId: w.a1, openingCash: 0 });
  await openShift(w.db, w.staffA.cashier2, { outletId: w.a2, openingCash: 0 });
});

describe('one member, one wallet per outlet', () => {
  it('a member registered at one outlet can be found, carded and served at another', async () => {
    const p = await mkPlayer(w, w.a1, 'Roaming Rhea', 0);
    expect((await searchMembers(w.db, w.staffA.cashier2, { q: 'Roaming' })).map((m) => m.id)).toContain(p.member.id);
    await recordPayment(w.db, w.staffA.cashier2, { outletId: w.a2, memberId: p.member.id, amount: rupees(800), method: 'cash', purpose: 'recharge', idempotencyKey: key() });
    expect(await balanceOf(w.db, p.member.id, w.a2)).toBe(rupees(800));
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(0);
  });

  it('chips at outlet 1 can only be bought with outlet 1 money', async () => {
    const t = await createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Roam Table' });
    const s = (await openSession(w.db, w.staffA.dealer, t.id)).id;
    const p = await mkPlayer(w, w.a1, 'Wrong Wallet', 0);
    await fund(w, w.a2, p.member.id, 5000);
    await seatPlayer(w.db, w.staffA.dealer, { sessionId: s, uid: p.uid });
    const err = await errorOf(issueChips(w.db, w.staffA.dealer, { sessionId: s, memberId: p.member.id, amount: rupees(100), idempotencyKey: key() }));
    expect(err?.code).toBe('low_balance');
  });

  it('a player seated at one outlet cannot be seated at another until they leave', async () => {
    const t1 = await createTable(w.db, w.ownerA, { outletId: w.a1, name: 'One Seat' });
    const s1 = (await openSession(w.db, w.staffA.dealer, t1.id)).id;
    const t2 = await createTable(w.db, w.ownerA, { outletId: w.a2, name: 'Two Seat' });
    const s2 = (await openSession(w.db, w.ownerA, t2.id)).id;
    const p = await mkPlayer(w, w.a1, 'Double Booked', 0);
    await seatPlayer(w.db, w.staffA.dealer, { sessionId: s1, uid: p.uid });
    expect((await errorOf(seatPlayer(w.db, w.ownerA, { sessionId: s2, uid: p.uid })))?.code).toBe('already_seated');
  });

  it('menus, tables and settings are separate per outlet', async () => {
    await addMenuItem(w.db, w.ownerA, { outletId: w.a2, name: 'Bandra Special', guestPrice: 100 });
    const board1 = await tablesBoard(w.db, w.staffA.dealer, w.a1);
    expect(board1.every((b) => b.table.outletId === w.a1)).toBe(true);
    expect((await errorOf(tablesBoard(w.db, w.staffA.dealer, w.a2)))?.code).toBe('forbidden');
  });
});

describe('owner roll-up across outlets', () => {
  it('breaks the books down per outlet and keeps every figure labelled and separate', async () => {
    const before2 = (await outletBooks(w.db, w.ownerA, w.a2)).collected.cash;
    const a = await mkPlayer(w, w.a1, 'Books One', 0);
    const b = await mkPlayer(w, w.a1, 'Books Two', 0);
    await recordPayment(w.db, w.staffA.cashier, { outletId: w.a1, memberId: a.member.id, amount: rupees(1000), method: 'cash', purpose: 'recharge', idempotencyKey: key() });
    await recordPayment(w.db, w.staffA.cashier, { outletId: w.a1, memberId: a.member.id, amount: rupees(400), method: 'card', purpose: 'recharge', idempotencyKey: key() });
    await recordPayment(w.db, w.staffA.cashier, { outletId: w.a1, memberId: b.member.id, amount: rupees(600), method: 'upi', purpose: 'recharge', idempotencyKey: key() });
    await recordPayment(w.db, w.staffA.cashier2, { outletId: w.a2, memberId: b.member.id, amount: rupees(250), method: 'cash', purpose: 'recharge', idempotencyKey: key() });

    const one = await outletBooks(w.db, w.ownerA, w.a1);
    expect(one.collected).toMatchObject({ cash: expect.any(Number), upi: 0, card: rupees(400), recharge: expect.any(Number) });
    expect(one.awaitingConfirmation).toBe(rupees(600));
    expect(one.revenue).toBeNull();

    const roll = await ownerRollup(w.db, w.ownerA);
    expect(roll.perOutlet.map((p) => p.outlet.id).sort()).toEqual([w.a1, w.a2].sort());
    const two = roll.perOutlet.find((p) => p.outlet.id === w.a2)!.books;
    expect(two.collected.cash - before2).toBe(rupees(250));
    expect(roll.totals.collected).toBe(roll.perOutlet.reduce((x, p) => x + p.books.collected.total, 0));
    expect(roll.totals.walletLiability).toBe(roll.perOutlet.reduce((x, p) => x + p.books.walletLiability, 0));
    expect(roll.revenue).toBeNull();
  });

  it('wallet liability matches the sum of ledger balances for the outlet', async () => {
    const books = await outletBooks(w.db, w.ownerA, w.a1);
    const { schema } = await import('@/db/client');
    const { eq, sql } = await import('drizzle-orm');
    const [row] = await w.db
      .select({ s: sql<number>`coalesce(sum(case when direction='cr' then amount else -amount end),0)::bigint` })
      .from(schema.walletLedger)
      .where(eq(schema.walletLedger.outletId, w.a1));
    expect(books.walletLiability).toBe(Number(row.s));
  });

  it('reports guest food net of reversals and keeps card fees apart from recharges', async () => {
    const books = await outletBooks(w.db, w.ownerA, w.a1);
    expect(books.feesCollected).toBe(books.collected.cardIssue + books.collected.cardReplacement);
    expect(books.guestFoodCharged).toBe(0);
  });

  it('counts chips outstanding in live sessions only', async () => {
    const t = await createTable(w.db, w.ownerA, { outletId: w.a2, name: 'Chip Books' });
    const s = (await openSession(w.db, w.ownerA, t.id)).id;
    const p = await mkPlayer(w, w.a2, 'Chipper', 2000);
    await seatPlayer(w.db, w.ownerA, { sessionId: s, uid: p.uid });
    await issueChips(w.db, w.ownerA, { sessionId: s, memberId: p.member.id, amount: rupees(700), idempotencyKey: key() });
    expect((await outletBooks(w.db, w.ownerA, w.a2)).chipsOutstanding).toBe(rupees(700));
  });

  it('floor overview covers every outlet, or one when asked', async () => {
    const all = await floorOverview(w.db, w.ownerA);
    expect(new Set(all.map((t) => t.outletId))).toEqual(new Set([w.a1, w.a2]));
    expect(all.find((t) => t.name === 'Chip Books')).toMatchObject({ inPlay: true, seats: [1] });
    const one = await floorOverview(w.db, w.ownerA, w.a2);
    expect(one.every((t) => t.outletId === w.a2)).toBe(true);
  });

  it('lists what needs the owner: submitted shifts and pending UPI payments, per outlet', async () => {
    const before = await decisionQueue(w.db, w.ownerA);
    expect(before.pendingPayments.length).toBeGreaterThan(0);
    expect(before.shifts.length).toBe(0);
    const cur = (await currentShift(w.db, w.staffA.cashier2, w.a2))!;
    await closeShift(w.db, w.staffA.cashier2, cur.shift.id, { counted: cur.expected });
    expect((await decisionQueue(w.db, w.ownerA)).shifts.length).toBe(1);
    expect((await decisionQueue(w.db, w.ownerA, w.a1)).shifts.length).toBe(0);
    expect((await errorOf(decisionQueue(w.db, w.ownerA, w.b1)))?.code).toBe('forbidden');
  });

  it('counts cards by status for the owner', async () => {
    const counts = await cardCounts(w.db, w.ownerA);
    expect(counts.active).toBeGreaterThan(0);
    expect((await cardCounts(w.db, w.ownerB)).active ?? 0).toBe(0);
  });

  it('staff cannot read the books or the roll-up', async () => {
    for (const ctx of [w.staffA.cashier, w.staffA.dealer, w.staffA.waiter, w.staffA.kds]) {
      expect((await errorOf(outletBooks(w.db, ctx, w.a1)))?.code).toBe('forbidden');
      expect((await errorOf(ownerRollup(w.db, ctx)))?.code).toBe('forbidden');
    }
  });
});

describe('tenant isolation between owners', () => {
  it('owner B’s roll-up never includes owner A’s outlets or money', async () => {
    await mkPlayer(w, w.b1, 'Bobs Money', 3000, { ctx: w.ownerB });
    const a = await ownerRollup(w.db, w.ownerA);
    const b = await ownerRollup(w.db, w.ownerB);
    expect(b.perOutlet.map((p) => p.outlet.id)).toEqual([w.b1]);
    expect(b.totals.walletLiability).toBe(rupees(3000));
    expect(a.perOutlet.some((p) => p.outlet.id === w.b1)).toBe(false);
  });

  it('owner A cannot read B’s outlet books, floor, or audit trail', async () => {
    expect((await errorOf(outletBooks(w.db, w.ownerA, w.b1)))?.code).toBe('forbidden');
    expect((await errorOf(floorOverview(w.db, w.ownerA, w.b1)))?.code).toBe('forbidden');
    const trailA = await listAudit(w.db, w.ownerA);
    const trailB = await listAudit(w.db, w.ownerB);
    expect(trailA.every((t) => t.ownerId === w.A.owner.id)).toBe(true);
    expect(trailB.every((t) => t.ownerId === w.B.owner.id)).toBe(true);
  });

  it('members, wallets and cards do not leak between owners', async () => {
    const mine = await mkPlayer(w, w.a1, 'Only Mine', 100);
    expect((await searchMembers(w.db, w.ownerB, { q: 'Only Mine' })).length).toBe(0);
    expect((await errorOf(adjustWallet(w.db, w.ownerB, { outletId: w.b1, memberId: mine.member.id, direction: 'cr', amount: 100, reason: 'steal', idempotencyKey: key() })))?.code).toBe('not_found');
  });

  it('audit rows can filter by outlet', async () => {
    const onlyA2 = await listAudit(w.db, w.ownerA, { outletId: w.a2 });
    expect(onlyA2.length).toBeGreaterThan(0);
    expect(onlyA2.every((t) => t.outletId === w.a2)).toBe(true);
  });
});

describe('ledger references', () => {
  it('shows the table name, not an internal id, for chip entries', async () => {
    const { recentLedger } = await import('@/server/reports');
    const rows = await recentLedger(w.db, w.ownerA, w.a2, 50);
    const chip = rows.find((r) => r.entry.type === 'chip_buy_in');
    expect(chip?.reference).toBe('Chip Books');
    expect(rows.every((r) => !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.reference))).toBe(true);
  });
});
