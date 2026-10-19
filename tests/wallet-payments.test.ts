import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { listAudit } from '@/server/audit';
import { confirmPayment, failPayment, getReceipt, listPayments, recordPayment } from '@/server/payments';
import { openShift } from '@/server/shifts';
import { adjustWallet, balanceOf, listLedger, postLedger, reverseEntry } from '@/server/wallet';
import { rupees } from '@/lib/money';
import { errorOf, key, mkPlayer, world, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
  await openShift(w.db, w.staffA.cashier, { outletId: w.a1, openingCash: rupees(1000) });
});

const recharge = (ctx: typeof w.staffA.cashier, memberId: string, rs: number, method: 'cash' | 'upi' | 'card' = 'cash', k = key()) =>
  recordPayment(w.db, ctx, { outletId: w.a1, memberId, amount: rupees(rs), method, purpose: 'recharge', idempotencyKey: k });

describe('payments', () => {
  it('cash and card recharges confirm at once and credit the wallet', async () => {
    const p = await mkPlayer(w, w.a1, 'Cash Carl');
    const { payment } = await recharge(w.staffA.cashier, p.member.id, 500);
    expect(payment.status).toBe('confirmed');
    expect(payment.receiptNo).toMatch(/^R-AND-\d{5}$/);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(500));
    await recharge(w.staffA.cashier, p.member.id, 250, 'card');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(750));
  });

  it('a UPI recharge stays pending and does not touch the wallet until confirmed', async () => {
    const p = await mkPlayer(w, w.a1, 'Upi Uma');
    const { payment } = await recharge(w.staffA.cashier, p.member.id, 1500, 'upi');
    expect(payment.status).toBe('pending');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(0);
    const rows = await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.memberId, p.member.id));
    expect(rows.length).toBe(0);
  });

  it('confirming credits exactly once even when confirmed repeatedly or at the same time', async () => {
    const p = await mkPlayer(w, w.a1, 'Callback Cal');
    const { payment } = await recharge(w.staffA.cashier, p.member.id, 1000, 'upi');
    const results = await Promise.all(
      [1, 2, 3].map(() => confirmPayment(w.db, w.staffA.cashier, payment.id, { gatewayRef: 'UTR-ABC-1' })),
    );
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(1000));
    await confirmPayment(w.db, w.staffA.cashier, payment.id, { gatewayRef: 'UTR-ABC-1' });
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(1000));
    expect((await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.paymentId, payment.id))).length).toBe(1);
  });

  it('needs a UPI reference to confirm, and a failed payment never credits', async () => {
    const p = await mkPlayer(w, w.a1, 'Failing Fay');
    const { payment } = await recharge(w.staffA.cashier, p.member.id, 400, 'upi');
    expect((await errorOf(confirmPayment(w.db, w.staffA.cashier, payment.id)))?.code).toBe('invalid');
    await failPayment(w.db, w.staffA.cashier, payment.id, 'Bank declined');
    expect((await errorOf(confirmPayment(w.db, w.staffA.cashier, payment.id, { gatewayRef: 'LATE-1' })))?.code).toBe('conflict');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(0);
    expect((await errorOf(failPayment(w.db, w.staffA.cashier, payment.id, 'again')))?.code).toBe('conflict');
  });

  it('a repeated submit with the same idempotency key returns the original payment and credits once', async () => {
    const p = await mkPlayer(w, w.a1, 'Double Tap Dan');
    const k = key();
    const first = await recharge(w.staffA.cashier, p.member.id, 300, 'cash', k);
    const second = await recharge(w.staffA.cashier, p.member.id, 300, 'cash', k);
    expect(second.replayed).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(300));
  });

  it('simultaneous identical requests create one payment', async () => {
    const p = await mkPlayer(w, w.a1, 'Racer Rae');
    const k = key();
    const settled = await Promise.allSettled([1, 2, 3, 4].map(() => recharge(w.staffA.cashier, p.member.id, 200, 'cash', k)));
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(200));
    expect((await w.db.select().from(schema.payments).where(eq(schema.payments.memberId, p.member.id))).filter((x) => x.purpose === 'recharge').length).toBe(1);
  });

  it('rejects zero, negative and fractional amounts', async () => {
    const p = await mkPlayer(w, w.a1, 'Bad Amount');
    for (const amount of [0, -100, 10.5]) {
      expect(await errorOf(recordPayment(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, amount, method: 'cash', purpose: 'recharge', idempotencyKey: key() }))).toBeDefined();
    }
  });

  it('numbers receipts in sequence per outlet', async () => {
    const p = await mkPlayer(w, w.a1, 'Receipt Rita');
    const a = await recharge(w.staffA.cashier, p.member.id, 100);
    const b = await recharge(w.staffA.cashier, p.member.id, 100);
    const n = (r: string) => Number(r.split('-')[2]);
    expect(n(b.payment.receiptNo)).toBe(n(a.payment.receiptNo) + 1);
  });

  it('builds a receipt with the PRD fields', async () => {
    const p = await mkPlayer(w, w.a1, 'Slip Sid');
    const { payment } = await recharge(w.staffA.cashier, p.member.id, 640, 'card');
    const r = await getReceipt(w.db, w.staffA.cashier, payment.id);
    expect(r).toMatchObject({ memberName: 'Slip Sid', purpose: 'recharge', amount: rupees(640), method: 'card', status: 'confirmed', outlet: 'Andheri' });
    expect(r.receiptNo).toBe(payment.receiptNo);
    expect(r.cashier).toContain('cashier');
  });

  it('cashiers must have an open shift, and the payment lands in that shift', async () => {
    const p = await mkPlayer(w, w.a2, 'Shiftless', 0);
    const err = await errorOf(recordPayment(w.db, w.staffA.cashier2, { outletId: w.a2, memberId: p.member.id, amount: 100, method: 'cash', purpose: 'recharge', idempotencyKey: key() }));
    expect(err?.message).toBe('Open a shift before taking payments.');
    const q = await mkPlayer(w, w.a1, 'In Shift');
    const { payment } = await recharge(w.staffA.cashier, q.member.id, 100);
    expect(payment.shiftId).not.toBeNull();
  });

  it('lists payments newest first and filters by status', async () => {
    const pending = await listPayments(w.db, w.staffA.cashier, w.a1, { status: 'pending' });
    expect(pending.every((r) => r.payment.status === 'pending')).toBe(true);
    const all = await listPayments(w.db, w.staffA.cashier, w.a1);
    expect(all.length).toBeGreaterThan(pending.length);
  });

  it('is limited to roles that handle money, and to the person’s own outlets', async () => {
    const p = await mkPlayer(w, w.a1, 'Guarded');
    const args = { outletId: w.a1, memberId: p.member.id, amount: 100, method: 'cash' as const, purpose: 'recharge' as const, idempotencyKey: key() };
    for (const ctx of [w.staffA.dealer, w.staffA.waiter, w.staffA.kds]) {
      expect((await errorOf(recordPayment(w.db, ctx, args)))?.code).toBe('forbidden');
    }
    expect((await errorOf(recordPayment(w.db, w.staffA.cashier2, args)))?.code).toBe('forbidden');
    expect((await errorOf(recordPayment(w.db, w.cashierB, args)))?.code).toBe('forbidden');
    expect((await errorOf(listPayments(w.db, w.staffA.cashier2, w.a1)))?.code).toBe('forbidden');
  });

  it('cannot take a payment for another owner’s member', async () => {
    const theirs = await mkPlayer(w, w.b1, 'Bobs Member', 0, { ctx: w.ownerB });
    expect((await errorOf(recharge(w.staffA.cashier, theirs.member.id, 100)))?.code).toBe('not_found');
  });

  it('keeps the audit trail for recorded and confirmed payments', async () => {
    const trail = await listAudit(w.db, w.ownerA, { category: 'Wallet' });
    expect(trail.some((t) => t.action === 'Payment recorded')).toBe(true);
    expect(trail.some((t) => t.action === 'Payment confirmed')).toBe(true);
  });
});

describe('wallet ledger', () => {
  it('keeps a separate balance per outlet for the same member', async () => {
    const p = await mkPlayer(w, w.a1, 'Two Wallets', 300);
    await post({ outletId: w.a2, memberId: p.member.id, type: 'recharge', direction: 'cr', amount: rupees(900), idempotencyKey: key() });
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(300));
    expect(await balanceOf(w.db, p.member.id, w.a2)).toBe(rupees(900));
  });

  it('refuses a debit larger than the balance with the PRD message and posts nothing', async () => {
    const p = await mkPlayer(w, w.a1, 'Short Sam', 100);
    const err = await errorOf(w.db.transaction((tx) => postLedger(tx, { outletId: w.a1, memberId: p.member.id, type: 'chip_buy_in', direction: 'dr', amount: rupees(101), idempotencyKey: key() })));
    expect(err?.message).toBe('Low balance. Please visit the counter to recharge.');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(100));
    expect((await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.memberId, p.member.id))).length).toBe(1);
  });

  it('simultaneous debits never overdraw the wallet', async () => {
    const p = await mkPlayer(w, w.a1, 'Double Spend', 100);
    const settled = await Promise.allSettled(
      [1, 2, 3].map(() => w.db.transaction((tx) => postLedger(tx, { outletId: w.a1, memberId: p.member.id, type: 'chip_buy_in', direction: 'dr', amount: rupees(60), idempotencyKey: key() }))),
    );
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBe(1);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(40));
  });

  it('is idempotent on the key and records balance-after on each line', async () => {
    const p = await mkPlayer(w, w.a1, 'Idem Ida', 0);
    const k = key();
    const a = await w.db.transaction((tx) => postLedger(tx, { outletId: w.a1, memberId: p.member.id, type: 'recharge', direction: 'cr', amount: 500, idempotencyKey: k }));
    const b = await w.db.transaction((tx) => postLedger(tx, { outletId: w.a1, memberId: p.member.id, type: 'recharge', direction: 'cr', amount: 500, idempotencyKey: k }));
    expect(b.replayed).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    expect(a.entry.balanceAfter).toBe(500);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(500);
  });

  it('rejects non-positive amounts at the service and in the database', async () => {
    const p = await mkPlayer(w, w.a1, 'Zero Zed', 100);
    expect(await errorOf(w.db.transaction((tx) => postLedger(tx, { outletId: w.a1, memberId: p.member.id, type: 'recharge', direction: 'cr', amount: 0, idempotencyKey: key() })))).toBeDefined();
    const [wallet] = await w.db.select().from(schema.wallets).where(eq(schema.wallets.memberId, p.member.id));
    const bad = w.db.insert(schema.walletLedger).values({ walletId: wallet.id, outletId: w.a1, memberId: p.member.id, type: 'recharge', direction: 'cr', amount: -5, balanceAfter: 0, idempotencyKey: key() });
    expect(await errorOf(bad)).toBeDefined();
  });

  it('the database refuses to edit or delete a posted line', async () => {
    const p = await mkPlayer(w, w.a1, 'Immutable Ivy', 100);
    const [row] = await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.memberId, p.member.id));
    expect((await errorOf(w.db.update(schema.walletLedger).set({ amount: 1 }).where(eq(schema.walletLedger.id, row.id))))?.message).toBeDefined();
    expect(await errorOf(w.db.delete(schema.walletLedger).where(eq(schema.walletLedger.id, row.id)))).toBeDefined();
    expect(await errorOf(w.db.delete(schema.auditLogs))).toBeDefined();
  });

  it('the database refuses a negative wallet balance', async () => {
    const p = await mkPlayer(w, w.a1, 'Negative Nat', 10);
    expect(await errorOf(w.db.update(schema.wallets).set({ balance: -1 }).where(eq(schema.wallets.memberId, p.member.id)))).toBeDefined();
  });

  it('lists a paginated ledger, newest first, only for visible outlets', async () => {
    const p = await mkPlayer(w, w.a1, 'Pages', 100);
    for (let i = 0; i < 4; i++) await post({ outletId: w.a1, memberId: p.member.id, type: 'recharge', direction: 'cr', amount: 100 + i, idempotencyKey: key() });
    const page1 = await listLedger(w.db, w.staffA.cashier, p.member.id, w.a1, { limit: 2 });
    const page2 = await listLedger(w.db, w.staffA.cashier, p.member.id, w.a1, { limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page1[0].amount).toBe(103);
    expect(page2.every((r) => !page1.some((x) => x.id === r.id))).toBe(true);
    expect((await errorOf(listLedger(w.db, w.staffA.cashier, p.member.id, w.a2)))?.code).toBe('forbidden');
    expect((await errorOf(listLedger(w.db, w.staffA.waiter, p.member.id, w.a1)))?.code).toBe('forbidden');
  });
});

describe('adjustments and reversals', () => {
  it('owner adjusts a balance with a reason, and it is audited', async () => {
    const p = await mkPlayer(w, w.a1, 'Goodwill Gus', 100);
    const e = await adjustWallet(w.db, w.ownerA, { outletId: w.a1, memberId: p.member.id, direction: 'cr', amount: rupees(50), reason: 'Goodwill after dispute', idempotencyKey: key() });
    expect(e.type).toBe('adjustment');
    expect(e.balanceAfter).toBe(rupees(150));
    const trail = await listAudit(w.db, w.ownerA, { category: 'Wallet' });
    expect(trail.some((t) => t.action === 'Manual adjustment credit' && t.reason === 'Goodwill after dispute')).toBe(true);
  });

  it('needs a reason and the right role; a debit cannot go below zero', async () => {
    const p = await mkPlayer(w, w.a1, 'Rules Ron', 100);
    const base = { outletId: w.a1, memberId: p.member.id, direction: 'cr' as const, amount: 100, idempotencyKey: key() };
    expect(await errorOf(adjustWallet(w.db, w.ownerA, { ...base, reason: '' }))).toBeDefined();
    expect((await errorOf(adjustWallet(w.db, w.staffA.cashier, { ...base, reason: 'because' })))?.code).toBe('forbidden');
    const err = await errorOf(adjustWallet(w.db, w.ownerA, { ...base, direction: 'dr', amount: rupees(500), reason: 'Take back' }));
    expect(err?.code).toBe('low_balance');
  });

  it('is idempotent on repeat submit', async () => {
    const p = await mkPlayer(w, w.a1, 'Twice Tess', 0);
    const args = { outletId: w.a1, memberId: p.member.id, direction: 'cr' as const, amount: 700, reason: 'Fix', idempotencyKey: key() };
    await adjustWallet(w.db, w.ownerA, args);
    await adjustWallet(w.db, w.ownerA, args);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(700);
  });

  it('amounts above the outlet threshold need a different active owner as approver', async () => {
    const p = await mkPlayer(w, w.a1, 'Big Bonus', 0);
    const big = { outletId: w.a1, memberId: p.member.id, direction: 'cr' as const, amount: rupees(6000), reason: 'Tournament prize fix', idempotencyKey: key() };
    expect((await errorOf(adjustWallet(w.db, w.ownerA, big)))?.message).toContain('second owner');
    expect((await errorOf(adjustWallet(w.db, w.ownerA, { ...big, secondApproverId: w.ownerA.userId })))?.message).toContain('second owner');
    expect((await errorOf(adjustWallet(w.db, w.ownerA, { ...big, secondApproverId: w.staffA.cashier.userId })))?.message).toContain('second owner');
    expect((await errorOf(adjustWallet(w.db, w.ownerA, { ...big, secondApproverId: w.ownerB.userId })))?.message).toContain('second owner');
    const [second] = await w.db.insert(schema.users).values({ email: 'second@a.test', name: 'Co Owner', passwordHash: 'x', role: 'owner', ownerId: w.A.owner.id }).returning();
    const e = await adjustWallet(w.db, w.ownerA, { ...big, secondApproverId: second.id });
    expect(e.balanceAfter).toBe(rupees(6000));
  });

  it('reverses a line once with a linked opposite line, never editing the original', async () => {
    const p = await mkPlayer(w, w.a1, 'Oops Olly', 0);
    const e = await adjustWallet(w.db, w.ownerA, { outletId: w.a1, memberId: p.member.id, direction: 'cr', amount: 900, reason: 'Wrong member', idempotencyKey: key() });
    const rev = await reverseEntry(w.db, w.ownerA, e.id, 'Posted to the wrong member');
    expect(rev.type).toBe('reversal');
    expect(rev.direction).toBe('dr');
    expect(rev.reversalOfId).toBe(e.id);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(0);
    expect((await errorOf(reverseEntry(w.db, w.ownerA, e.id, 'again')))?.code).toBe('conflict');
    expect((await errorOf(reverseEntry(w.db, w.ownerA, rev.id, 'undo the undo')))?.code).toBe('invalid');
    const [orig] = await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.id, e.id));
    expect(orig.amount).toBe(900);
  });

  it('two simultaneous reversals produce one', async () => {
    const p = await mkPlayer(w, w.a1, 'Race Rev', 0);
    const e = await adjustWallet(w.db, w.ownerA, { outletId: w.a1, memberId: p.member.id, direction: 'cr', amount: 1000, reason: 'Fix', idempotencyKey: key() });
    const settled = await Promise.allSettled([reverseEntry(w.db, w.ownerA, e.id, 'a'), reverseEntry(w.db, w.ownerA, e.id, 'b')]);
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBe(1);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(0);
  });

  it('cannot reverse another outlet’s or owner’s entry', async () => {
    const p = await mkPlayer(w, w.a1, 'Cross Rev', 100);
    const [row] = await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.memberId, p.member.id));
    expect((await errorOf(reverseEntry(w.db, w.ownerB, row.id, 'x')))?.code).toBe('forbidden');
    expect((await errorOf(reverseEntry(w.db, w.staffA.cashier, row.id, 'x')))?.code).toBe('forbidden');
  });

  it('refuses adjustments for another owner’s member or outlet', async () => {
    const theirs = await mkPlayer(w, w.b1, 'Bob Only', 100, { ctx: w.ownerB });
    expect((await errorOf(adjustWallet(w.db, w.ownerA, { outletId: w.a1, memberId: theirs.member.id, direction: 'cr', amount: 100, reason: 'steal', idempotencyKey: key() })))?.code).toBe('not_found');
    expect((await errorOf(adjustWallet(w.db, w.ownerA, { outletId: w.b1, memberId: theirs.member.id, direction: 'cr', amount: 100, reason: 'steal', idempotencyKey: key() })))?.code).toBe('forbidden');
  });
});

type PostArgs = Parameters<typeof postLedger>[1];
const post = (input: PostArgs) => w.db.transaction((tx) => postLedger(tx, input));
