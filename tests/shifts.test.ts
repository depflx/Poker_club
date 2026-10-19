import { beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '@/server/audit';
import { confirmPayment, recordPayment } from '@/server/payments';
import { approveShift, closeShift, currentShift, listShifts, openShift, rejectShift } from '@/server/shifts';
import { rupees } from '@/lib/money';
import { errorOf, key, mkPlayer, world, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
});

const pay = (ctx: typeof w.staffA.cashier, memberId: string, rs: number, method: 'cash' | 'card' | 'upi', purpose: 'recharge' | 'card_issue' = 'recharge') =>
  recordPayment(w.db, ctx, { outletId: w.a1, memberId, amount: rupees(rs), method, purpose, idempotencyKey: key() });

describe('cashier shifts', () => {
  it('opens a shift with an opening float and allows only one open shift per cashier per outlet', async () => {
    const s = await openShift(w.db, w.staffA.cashier, { outletId: w.a1, openingCash: rupees(5000) });
    expect(s.status).toBe('open');
    expect(s.openingCash).toBe(rupees(5000));
    expect((await errorOf(openShift(w.db, w.staffA.cashier, { outletId: w.a1, openingCash: 0 })))?.code).toBe('conflict');
    expect((await errorOf(openShift(w.db, w.staffA.cashier2, { outletId: w.a1, openingCash: 0 })))?.code).toBe('forbidden');
    expect(await errorOf(openShift(w.db, w.staffA.cashier2, { outletId: w.a2, openingCash: -1 }))).toBeDefined();
  });

  it('totals confirmed payments by method and excludes pending UPI', async () => {
    const p = await mkPlayer(w, w.a1, 'Shift Sam');
    await pay(w.staffA.cashier, p.member.id, 1000, 'cash');
    await pay(w.staffA.cashier, p.member.id, 400, 'card');
    const upi = await pay(w.staffA.cashier, p.member.id, 300, 'upi');
    await pay(w.staffA.cashier, p.member.id, 700, 'upi').then((r) => confirmPayment(w.db, w.staffA.cashier, r.payment.id, { gatewayRef: 'UTR-77' }));
    const cur = await currentShift(w.db, w.staffA.cashier, w.a1);
    expect(cur!.expected).toEqual({ cash: rupees(6000), card: rupees(400), upi: rupees(700) });
    expect(upi.payment.status).toBe('pending');
  });

  it('closes with counted figures, reports differences, and refuses a silent mismatch', async () => {
    const cur = (await currentShift(w.db, w.staffA.cashier, w.a1))!;
    const counted = { cash: cur.expected.cash - rupees(120), card: cur.expected.card, upi: cur.expected.upi };
    const err = await errorOf(closeShift(w.db, w.staffA.cashier, cur.shift.id, { counted }));
    expect(err?.code).toBe('invalid');
    const closed = await closeShift(w.db, w.staffA.cashier, cur.shift.id, { counted, note: 'Gave change to a member' });
    expect(closed.status).toBe('review');
    expect(closed.discrepancy).toBe(-rupees(120));
    expect(closed.expected).toEqual(cur.expected);
    expect(closed.counted).toEqual(counted);
    expect((await errorOf(closeShift(w.db, w.staffA.cashier, cur.shift.id, { counted })))?.code).toBe('conflict');
  });

  it('stops new payments once the shift is closed', async () => {
    const p = await mkPlayer(w, w.a1, 'After Close');
    const err = await errorOf(pay(w.staffA.cashier, p.member.id, 100, 'cash'));
    expect(err?.message).toBe('Open a shift before taking payments.');
  });

  it('only the owner can approve, and an approved shift is locked', async () => {
    const [{ shift }] = await listShifts(w.db, w.ownerA, w.a1, 'review');
    expect((await errorOf(approveShift(w.db, w.staffA.cashier, shift.id)))?.code).toBe('forbidden');
    const ok = await approveShift(w.db, w.ownerA, shift.id, 'Checked the till log');
    expect(ok.status).toBe('approved');
    expect(ok.reviewerId).toBe(w.ownerA.userId);
    expect((await errorOf(approveShift(w.db, w.ownerA, shift.id)))?.code).toBe('conflict');
    expect((await errorOf(rejectShift(w.db, w.ownerA, shift.id, 'too late')))?.code).toBe('conflict');
    expect((await errorOf(closeShift(w.db, w.staffA.cashier, shift.id, { counted: { cash: 0, card: 0, upi: 0 } })))?.code).toBe('conflict');
  });

  it('the owner can send a shift back with a reason, and the cashier recounts', async () => {
    const s = await openShift(w.db, w.staffA.cashier, { outletId: w.a1, openingCash: rupees(100) });
    await closeShift(w.db, w.staffA.cashier, s.id, { counted: { cash: rupees(100), card: 0, upi: 0 } });
    expect((await errorOf(rejectShift(w.db, w.ownerA, s.id, ' ')))?.code).toBe('invalid');
    const back = await rejectShift(w.db, w.ownerA, s.id, 'Recount the card slips');
    expect(back.status).toBe('open');
    expect(back.reviewNote).toBe('Recount the card slips');
    const again = await closeShift(w.db, w.staffA.cashier, s.id, { counted: { cash: rupees(100), card: 0, upi: 0 } });
    expect(again.status).toBe('review');
    await approveShift(w.db, w.ownerA, s.id);
  });

  it('a cashier cannot close someone else’s shift or approve their own', async () => {
    const s = await openShift(w.db, w.staffA.cashier2, { outletId: w.a2, openingCash: 0 });
    expect((await errorOf(closeShift(w.db, w.staffA.cashier, s.id, { counted: { cash: 0, card: 0, upi: 0 } })))?.code).toBe('forbidden');
    await closeShift(w.db, w.staffA.cashier2, s.id, { counted: { cash: 0, card: 0, upi: 0 } });
    expect((await errorOf(approveShift(w.db, w.staffA.cashier2, s.id)))?.code).toBe('forbidden');
  });

  it('keeps shifts per outlet: an owner sees only outlets they own', async () => {
    expect((await errorOf(listShifts(w.db, w.ownerB, w.a1)))?.code).toBe('forbidden');
    expect((await listShifts(w.db, w.ownerA, w.a2)).length).toBe(1);
    expect((await listShifts(w.db, w.ownerA, w.a1)).length).toBeGreaterThanOrEqual(2);
  });

  it('writes opened, submitted and approved shifts to the audit trail', async () => {
    const actions = (await listAudit(w.db, w.ownerA, { category: 'Shifts' })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['Shift opened', 'Shift submitted for review', 'Shift approved and locked', 'Shift sent back to cashier']));
  });
});
