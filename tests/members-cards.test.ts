import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { blockCard, issueCard, lookupCard, replaceCard } from '@/server/cards';
import { createMember, getMemberProfile, searchMembers, setMemberStatus } from '@/server/members';
import { listAudit } from '@/server/audit';
import { openShift } from '@/server/shifts';
import { balanceOf } from '@/server/wallet';
import { rupees } from '@/lib/money';
import { errorOf, fund, key, mkPlayer, world, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
  await openShift(w.db, w.staffA.cashier, { outletId: w.a1, openingCash: rupees(5000) });
});

describe('members', () => {
  it('registers a member with an owner-wide number and no card yet', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Arjun Mehta', mobile: '9810000001', tier: 'Gold' });
    expect(m.memberNumber).toBe('M-1001');
    expect(m.homeOutletId).toBe(w.a1);
    const next = await createMember(w.db, w.staffA.cashier2, { outletId: w.a2, name: 'Kavya Rao', mobile: '9810000002' });
    expect(next.memberNumber).toBe('M-1002');
  });

  it('rejects a duplicate mobile across the whole owner and names the existing member', async () => {
    const err = await errorOf(createMember(w.db, w.staffA.cashier2, { outletId: w.a2, name: 'Someone Else', mobile: '9810000001' }));
    expect(err?.code).toBe('conflict');
    expect(err?.message).toContain('Arjun Mehta');
    expect(err?.message).toContain('M-1001');
  });

  it('allows the same mobile under a different owner', async () => {
    const m = await createMember(w.db, w.cashierB, { outletId: w.b1, name: 'Arjun Elsewhere', mobile: '9810000001' });
    expect(m.memberNumber).toBe('M-1001');
  });

  it('validates name and mobile', async () => {
    expect(await errorOf(createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'A', mobile: '9810000009' }))).toBeDefined();
    expect(await errorOf(createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Valid Name', mobile: '12345' }))).toBeDefined();
  });

  it('only registers members at outlets the person works at', async () => {
    expect((await errorOf(createMember(w.db, w.staffA.cashier, { outletId: w.a2, name: 'Wrong Outlet', mobile: '9810000010' })))?.code).toBe('forbidden');
  });

  it('roles without member rights cannot register', async () => {
    expect((await errorOf(createMember(w.db, w.staffA.waiter, { outletId: w.a1, name: 'Waiter Try', mobile: '9810000011' })))?.code).toBe('forbidden');
    expect((await errorOf(createMember(w.db, w.staffA.kds, { outletId: w.a1, name: 'Kitchen Try', mobile: '9810000012' })))?.code).toBe('forbidden');
  });

  it('searches by name, mobile, member number and card UID, scoped to the owner', async () => {
    const p = await mkPlayer(w, w.a1, 'Searchable Sam', 0);
    expect((await searchMembers(w.db, w.ownerA, { q: 'searchable' })).map((m) => m.id)).toContain(p.member.id);
    expect((await searchMembers(w.db, w.ownerA, { q: p.member.mobile })).length).toBe(1);
    expect((await searchMembers(w.db, w.ownerA, { q: p.member.memberNumber }))[0].id).toBe(p.member.id);
    const byCard = await searchMembers(w.db, w.ownerA, { q: p.uid.slice(0, 8).toLowerCase() });
    expect(byCard.some((m) => m.id === p.member.id && m.activeCardUid === p.uid)).toBe(true);
    expect((await searchMembers(w.db, w.ownerB, { q: 'searchable' })).length).toBe(0);
  });

  it('filters by status', async () => {
    const p = await mkPlayer(w, w.a1, 'Soon Suspended', 0);
    await setMemberStatus(w.db, w.ownerA, p.member.id, 'suspended', 'Chip count dispute');
    expect((await searchMembers(w.db, w.ownerA, { status: 'suspended' })).map((m) => m.id)).toContain(p.member.id);
    expect((await searchMembers(w.db, w.ownerA, { status: 'active' })).map((m) => m.id)).not.toContain(p.member.id);
  });

  it('only the owner can suspend, with a reason, and the change is audited', async () => {
    const p = await mkPlayer(w, w.a1, 'Audit Me', 0);
    expect((await errorOf(setMemberStatus(w.db, w.staffA.cashier, p.member.id, 'suspended', 'x')))?.code).toBe('forbidden');
    expect((await errorOf(setMemberStatus(w.db, w.ownerA, p.member.id, 'suspended', '  ')))?.code).toBe('invalid');
    await setMemberStatus(w.db, w.ownerA, p.member.id, 'suspended', 'Complaint');
    const trail = await listAudit(w.db, w.ownerA, { category: 'Members' });
    const row = trail.find((t) => t.action === 'Member suspended' && t.entityId === p.member.id)!;
    expect(row.reason).toBe('Complaint');
  });

  it('cannot read or change another owner’s member', async () => {
    const p = await mkPlayer(w, w.a1, 'Private Pat', 0);
    expect((await errorOf(getMemberProfile(w.db, w.cashierB, p.member.id, w.b1)))?.code).toBe('not_found');
    expect((await errorOf(setMemberStatus(w.db, w.ownerB, p.member.id, 'suspended', 'x')))?.code).toBe('not_found');
  });

  it('shows the profile with full card history and balances only for outlets the viewer can see', async () => {
    const p = await mkPlayer(w, w.a1, 'Two Outlets', 100);
    await fund(w, w.a2, p.member.id, 250);
    const owner = await getMemberProfile(w.db, w.ownerA, p.member.id, w.a1);
    expect(owner.balance).toBe(rupees(100));
    expect(owner.balances.length).toBe(2);
    const cashier = await getMemberProfile(w.db, w.staffA.cashier, p.member.id, w.a1);
    expect(cashier.balances.length).toBe(1);
    expect(cashier.cards.length).toBe(1);
  });
});

describe('card issue', () => {
  it('issues a card with the fee as a separate confirmed payment and no wallet credit', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'New Card', mobile: '9820000001' });
    const card = await issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: m.id, uid: 'abc-1001', method: 'cash', idempotencyKey: key() });
    expect(card.uid).toBe('ABC-1001');
    expect(card.status).toBe('active');
    const [pay] = await w.db.select().from(schema.payments).where(eq(schema.payments.cardId, card.id));
    expect(pay.purpose).toBe('card_issue');
    expect(pay.amount).toBe(10000);
    expect(pay.status).toBe('confirmed');
    expect(await balanceOf(w.db, m.id, w.a1)).toBe(0);
  });

  it('is idempotent when the same card is submitted again', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Double Tap', mobile: '9820000002' });
    const args = { outletId: w.a1, memberId: m.id, uid: 'DT-0001', method: 'cash' as const, idempotencyKey: key() };
    const a = await issueCard(w.db, w.staffA.cashier, args);
    const b = await issueCard(w.db, w.staffA.cashier, args);
    expect(b.id).toBe(a.id);
    expect((await w.db.select().from(schema.payments).where(eq(schema.payments.cardId, a.id))).length).toBe(1);
  });

  it('refuses a card already registered, with the PRD message and no changes', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Wants Taken Card', mobile: '9820000003' });
    const taken = await mkPlayer(w, w.a1, 'Card Owner', 0);
    const err = await errorOf(issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: m.id, uid: taken.uid, method: 'cash', idempotencyKey: key() }));
    expect(err?.code).toBe('duplicate_card');
    expect(err?.message).toBe('This card is already registered. No changes were made.');
    expect((await w.db.select().from(schema.cards).where(eq(schema.cards.memberId, m.id))).length).toBe(0);
  });

  it('refuses a UID registered under another owner without revealing whose it is', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Cross Owner', mobile: '9820000004' });
    const bobs = await mkPlayer(w, w.b1, 'Bobs Player', 0, { ctx: w.ownerB });
    const err = await errorOf(issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: m.id, uid: bobs.uid, method: 'cash', idempotencyKey: key() }));
    expect(err?.code).toBe('duplicate_card');
  });

  it('allows only one active card per member', async () => {
    const p = await mkPlayer(w, w.a1, 'Has A Card', 0);
    const err = await errorOf(issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, uid: 'SECOND-01', method: 'cash', idempotencyKey: key() }));
    expect(err?.code).toBe('conflict');
  });

  it('requires the fee, and a pending UPI fee does not issue the card', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Fee Dodger', mobile: '9820000005' });
    expect((await errorOf(issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: m.id, uid: 'FEE-0001', idempotencyKey: key() })))?.code).toBe('invalid');
    const upi = await errorOf(issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: m.id, uid: 'FEE-0001', method: 'upi', idempotencyKey: key() }));
    expect(upi?.code).toBe('payment_pending');
    expect((await w.db.select().from(schema.cards).where(eq(schema.cards.uid, 'FEE-0001'))).length).toBe(0);
    expect((await w.db.select().from(schema.payments).where(eq(schema.payments.memberId, m.id))).length).toBe(0);
  });

  it('suspended members cannot be issued a card', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Suspended New', mobile: '9820000006' });
    await setMemberStatus(w.db, w.ownerA, m.id, 'suspended', 'Test');
    expect((await errorOf(issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: m.id, uid: 'SUS-0001', method: 'cash', idempotencyKey: key() })))?.code).toBe('invalid');
  });

  it('cashiers need an open shift, and dealers and waiters cannot issue cards', async () => {
    const m = await createMember(w.db, w.staffA.cashier2, { outletId: w.a2, name: 'No Shift', mobile: '9820000007' });
    const err = await errorOf(issueCard(w.db, w.staffA.cashier2, { outletId: w.a2, memberId: m.id, uid: 'NS-0001', method: 'cash', idempotencyKey: key() }));
    expect(err?.message).toContain('Open a shift');
    expect((await errorOf(issueCard(w.db, w.staffA.dealer, { outletId: w.a1, memberId: m.id, uid: 'NS-0002', method: 'cash', idempotencyKey: key() })))?.code).toBe('forbidden');
  });
});

describe('lost cards and replacement', () => {
  it('blocks a lost card immediately for protected lookups and keeps profile and wallet', async () => {
    const p = await mkPlayer(w, w.a1, 'Loses Card', 500);
    expect((await lookupCard(w.db, w.staffA.dealer, p.uid)).member.id).toBe(p.member.id);
    const [card] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, p.uid));
    await blockCard(w.db, w.staffA.cashier, { cardId: card.id, reason: 'Lost at venue' });
    const err = await errorOf(lookupCard(w.db, w.staffA.dealer, p.uid));
    expect(err?.code).toBe('blocked_card');
    expect(err?.message).toBe('This card is blocked. Please visit the counter.');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(500));
  });

  it('requires a reason, only blocks active cards, and records who and why', async () => {
    const p = await mkPlayer(w, w.a1, 'Block Rules', 0);
    const [card] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, p.uid));
    expect((await errorOf(blockCard(w.db, w.staffA.cashier, { cardId: card.id, reason: ' ' })))?.code).toBe('invalid');
    await blockCard(w.db, w.staffA.cashier, { cardId: card.id, reason: 'Snapped in half', kind: 'damaged' });
    expect((await errorOf(blockCard(w.db, w.staffA.cashier, { cardId: card.id, reason: 'again' })))?.code).toBe('conflict');
    const trail = await listAudit(w.db, w.ownerA, { category: 'Cards' });
    const row = trail.find((t) => t.action === 'Card blocked' && t.entityId === card.id)!;
    expect(row.actorId).toBe(w.staffA.cashier.userId);
    expect(row.reason).toBe('Snapped in half');
    expect((row.before as { status: string }).status).toBe('active');
  });

  it('replaces a lost card on the same member, keeps the wallet, and retires the old card', async () => {
    const p = await mkPlayer(w, w.a1, 'Replace Me', 800);
    const [old] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, p.uid));
    await blockCard(w.db, w.staffA.cashier, { cardId: old.id, reason: 'Lost' });
    const fresh = await replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: 'NEW-REPL-1', method: 'cash', idempotencyKey: key() });
    expect(fresh.status).toBe('active');
    expect(fresh.memberId).toBe(p.member.id);
    const [retired] = await w.db.select().from(schema.cards).where(eq(schema.cards.id, old.id));
    expect(retired.status).toBe('replaced');
    expect(retired.replacedByCardId).toBe(fresh.id);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(800));
    expect((await lookupCard(w.db, w.staffA.dealer, 'NEW-REPL-1')).member.id).toBe(p.member.id);
    expect((await errorOf(lookupCard(w.db, w.staffA.dealer, p.uid)))?.code).toBe('blocked_card');
  });

  it('keeps the replacement fee and a wallet recharge as two separate transactions', async () => {
    const p = await mkPlayer(w, w.a1, 'Separate Money', 0);
    const [old] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, p.uid));
    await blockCard(w.db, w.staffA.cashier, { cardId: old.id, reason: 'Lost' });
    const fresh = await replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: 'NEW-SEP-01', method: 'card', idempotencyKey: key() });
    const [fee] = await w.db.select().from(schema.payments).where(eq(schema.payments.cardId, fresh.id));
    expect(fee.purpose).toBe('card_replacement');
    expect(fee.method).toBe('card');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(0);
    expect((await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.memberId, p.member.id))).length).toBe(0);
  });

  it('can replace a card that is still active by blocking it in the same step, with a reason', async () => {
    const p = await mkPlayer(w, w.a1, 'Active Replace', 0);
    expect((await errorOf(replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: 'NEW-ACT-01', method: 'cash', idempotencyKey: key() })))?.code).toBe('invalid');
    await replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: 'NEW-ACT-01', reason: 'Worn out', method: 'cash', idempotencyKey: key() });
    expect((await errorOf(lookupCard(w.db, w.staffA.dealer, p.uid)))?.code).toBe('blocked_card');
  });

  it('keeps every replacement visible when a member is replaced repeatedly', async () => {
    const p = await mkPlayer(w, w.a1, 'Serial Loser', 0);
    let uid = p.uid;
    for (const next of ['SER-0002', 'SER-0003']) {
      const [c] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, uid));
      await blockCard(w.db, w.staffA.cashier, { cardId: c.id, reason: 'Lost again' });
      await replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: next, method: 'cash', idempotencyKey: key() });
      uid = next;
    }
    const profile = await getMemberProfile(w.db, w.ownerA, p.member.id, w.a1);
    expect(profile.cards.map((c) => c.status).sort()).toEqual(['active', 'replaced', 'replaced']);
  });

  it('never silently reactivates a blocked card by issuing it again', async () => {
    const p = await mkPlayer(w, w.a1, 'No Zombie', 0);
    const [c] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, p.uid));
    await blockCard(w.db, w.staffA.cashier, { cardId: c.id, reason: 'Lost' });
    const err = await errorOf(issueCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, uid: p.uid, method: 'cash', idempotencyKey: key() }));
    expect(err?.code).toBe('duplicate_card');
  });

  it('refuses to replace when the new card belongs to someone else', async () => {
    const p = await mkPlayer(w, w.a1, 'Wants Other Card', 0);
    const other = await mkPlayer(w, w.a1, 'Other Card Holder', 0);
    const err = await errorOf(replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: other.uid, reason: 'Lost', method: 'cash', idempotencyKey: key() }));
    expect(err?.code).toBe('duplicate_card');
    expect((await lookupCard(w.db, w.staffA.dealer, p.uid)).member.id).toBe(p.member.id);
  });

  it('pays a UPI replacement fee through a confirmed payment', async () => {
    const { recordPayment, confirmPayment } = await import('@/server/payments');
    const p = await mkPlayer(w, w.a1, 'Upi Replace', 0);
    const [old] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, p.uid));
    await blockCard(w.db, w.staffA.cashier, { cardId: old.id, reason: 'Lost' });
    const { payment } = await recordPayment(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, amount: 20000, method: 'upi', purpose: 'card_replacement', idempotencyKey: key() });
    const pending = await errorOf(replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: 'UPI-REP-01', paymentId: payment.id, idempotencyKey: key() }));
    expect(pending?.code).toBe('payment_pending');
    await confirmPayment(w.db, w.staffA.cashier, payment.id, { gatewayRef: 'UTR123456' });
    const fresh = await replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: 'UPI-REP-01', paymentId: payment.id, idempotencyKey: key() });
    expect(fresh.status).toBe('active');
    const again = await errorOf(replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: p.member.id, newUid: 'UPI-REP-02', reason: 'x', paymentId: payment.id, idempotencyKey: key() }));
    expect(again?.code).toBe('conflict');
  });

  it('cannot replace for a member with no card history', async () => {
    const m = await createMember(w.db, w.staffA.cashier, { outletId: w.a1, name: 'Never Had One', mobile: '9830000001' });
    expect((await errorOf(replaceCard(w.db, w.staffA.cashier, { outletId: w.a1, memberId: m.id, newUid: 'NH-0001', method: 'cash', idempotencyKey: key() })))?.code).toBe('invalid');
  });
});

describe('card lookup for protected actions', () => {
  it('rejects unknown, unassigned and other-owner cards with the same PRD message', async () => {
    const msg = 'Card not recognized. Verify the card or contact the counter.';
    expect((await errorOf(lookupCard(w.db, w.staffA.dealer, 'NOT-A-CARD')))?.message).toBe(msg);
    await w.db.insert(schema.cards).values({ ownerId: w.A.owner.id, uid: 'BLANK-01', status: 'unassigned' });
    expect((await errorOf(lookupCard(w.db, w.staffA.dealer, 'BLANK-01')))?.message).toBe(msg);
    const bobs = await mkPlayer(w, w.b1, 'Bobs Other', 0, { ctx: w.ownerB });
    expect((await errorOf(lookupCard(w.db, w.staffA.dealer, bobs.uid)))?.message).toBe(msg);
  });

  it('rejects the card of a suspended member', async () => {
    const p = await mkPlayer(w, w.a1, 'Suspended Holder', 0);
    await setMemberStatus(w.db, w.ownerA, p.member.id, 'suspended', 'Test');
    expect((await errorOf(lookupCard(w.db, w.staffA.dealer, p.uid)))?.code).toBe('blocked_card');
  });

  it('is case and whitespace insensitive', async () => {
    const p = await mkPlayer(w, w.a1, 'Spacey', 0);
    expect((await lookupCard(w.db, w.staffA.dealer, `  ${p.uid.toLowerCase()}  `)).member.id).toBe(p.member.id);
  });
});
