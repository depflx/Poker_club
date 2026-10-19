import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { listAudit } from '@/server/audit';
import { blockCard } from '@/server/cards';
import { setMemberStatus } from '@/server/members';
import {
  closeSession, correctRound, createRound, createTable, issueChips, leaveSeat, listRounds, openSession, resolveException,
  returnChips, seatPlayer, sessionSummary, submitRound, tablesBoard, updateDraftRound, updateTable,
} from '@/server/poker';
import { balanceOf } from '@/server/wallet';
import { rupees } from '@/lib/money';
import { errorOf, key, mkPlayer, world, type World } from './helpers';

let w: World;
let table1: string;
beforeAll(async () => {
  w = await world();
  table1 = (await createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Table 1' })).id;
});

const dealer = () => w.staffA.dealer;
async function session(name = `T-${key()}`) {
  const t = await createTable(w.db, w.ownerA, { outletId: w.a1, name });
  return (await openSession(w.db, dealer(), t.id)).id;
}
async function seated(sessionId: string, name: string, balance = 5000) {
  const p = await mkPlayer(w, w.a1, name, balance);
  await seatPlayer(w.db, dealer(), { sessionId, uid: p.uid });
  return p;
}
const chips = (sessionId: string, memberId: string, rs: number, k = key()) =>
  issueChips(w.db, dealer(), { sessionId, memberId, amount: rupees(rs), idempotencyKey: k });

describe('tables and sessions', () => {
  it('creates tables with a seat cap of eight at most and unique names per outlet', async () => {
    expect(await errorOf(createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Big', maxSeats: 9 }))).toBeDefined();
    expect((await errorOf(createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Table 1' })))?.code).toBe('conflict');
    expect((await createTable(w.db, w.ownerA, { outletId: w.a2, name: 'Table 1' })).maxSeats).toBe(8);
    expect((await errorOf(createTable(w.db, w.staffA.dealer, { outletId: w.a1, name: 'Mine' })))?.code).toBe('forbidden');
  });

  it('refuses to raise a table past eight seats, even directly in the database', async () => {
    expect(await errorOf(updateTable(w.db, w.ownerA, table1, { maxSeats: 12 }))).toBeDefined();
    expect(await errorOf(w.db.update(schema.pokerTables).set({ maxSeats: 12 }).where(eq(schema.pokerTables.id, table1)))).toBeDefined();
  });

  it('starts one session per table and assigns the operator', async () => {
    const s = await openSession(w.db, dealer(), table1);
    expect(s.operatorId).toBe(dealer().userId);
    expect((await errorOf(openSession(w.db, dealer(), table1)))?.code).toBe('conflict');
    await closeSession(w.db, dealer(), s.id);
    expect((await openSession(w.db, dealer(), table1)).status).toBe('in_progress');
  });

  it('simultaneous session starts create one', async () => {
    const t = await createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Race Table' });
    const settled = await Promise.allSettled([openSession(w.db, dealer(), t.id), openSession(w.db, dealer(), t.id)]);
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBe(1);
  });

  it('blocks tables the dealer does not work at, and inactive tables', async () => {
    const other = await createTable(w.db, w.ownerA, { outletId: w.a2, name: 'Bandra T' });
    expect((await errorOf(openSession(w.db, dealer(), other.id)))?.code).toBe('forbidden');
    const t = await createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Dark Table' });
    await updateTable(w.db, w.ownerA, t.id, { active: false });
    expect((await errorOf(openSession(w.db, dealer(), t.id)))?.code).toBe('conflict');
  });

  it('waiters and kitchen staff cannot operate the floor', async () => {
    expect((await errorOf(openSession(w.db, w.staffA.waiter, table1)))?.code).toBe('forbidden');
    expect((await errorOf(tablesBoard(w.db, w.staffA.kds, w.a1)))?.code).toBe('forbidden');
  });
});

describe('seating', () => {
  it('seats players by card at the lowest free seat and rejects the ninth', async () => {
    const s = await session();
    for (let i = 1; i <= 8; i++) {
      const p = await mkPlayer(w, w.a1, `Seat ${i}`, 0);
      const row = await seatPlayer(w.db, dealer(), { sessionId: s, uid: p.uid });
      expect(row.seatNumber).toBe(i);
    }
    const ninth = await mkPlayer(w, w.a1, 'Ninth', 0);
    const err = await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: ninth.uid }));
    expect(err?.code).toBe('table_full');
    expect(err?.message).toBe('This table has reached its 8-player limit.');
    const active = await w.db.select().from(schema.sessionPlayers).where(eq(schema.sessionPlayers.sessionId, s));
    expect(active.length).toBe(8);
  });

  it('under a concurrent rush never seats more than eight', async () => {
    const s = await session();
    const players = await Promise.all(Array.from({ length: 12 }, (_, i) => mkPlayer(w, w.a1, `Rush ${i}`, 0)));
    const settled = await Promise.allSettled(players.map((p) => seatPlayer(w.db, dealer(), { sessionId: s, uid: p.uid })));
    expect(settled.filter((x) => x.status === 'fulfilled').length).toBe(8);
    const rows = await w.db.select().from(schema.sessionPlayers).where(eq(schema.sessionPlayers.sessionId, s));
    expect(rows.length).toBe(8);
    expect(new Set(rows.map((r) => r.seatNumber)).size).toBe(8);
  });

  it('two taps of the same card seat one player', async () => {
    const s = await session();
    const p = await mkPlayer(w, w.a1, 'Twice', 0);
    const settled = await Promise.allSettled([1, 2].map(() => seatPlayer(w.db, dealer(), { sessionId: s, uid: p.uid })));
    expect(settled.filter((x) => x.status === 'fulfilled').length).toBe(1);
    const err = await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: p.uid }));
    expect(err?.message).toBe('This player is already active at a table.');
  });

  it('a player cannot sit at two tables at once, even at different outlets of the same owner', async () => {
    const s1 = await session();
    const p = await seated(s1, 'Wanderer', 0);
    const s2 = await session();
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: s2, uid: p.uid })))?.code).toBe('already_seated');
    const direct = w.db.insert(schema.sessionPlayers).values({ sessionId: s2, memberId: p.member.id, seatNumber: 3 });
    expect(await errorOf(direct)).toBeDefined();
  });

  it('rejects blocked, unknown and suspended-member cards with the PRD messages', async () => {
    const s = await session();
    const lost = await mkPlayer(w, w.a1, 'Lost', 0);
    const [card] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, lost.uid));
    await blockCard(w.db, w.staffA.cashier, { cardId: card.id, reason: 'Lost' }).catch(() => blockCard(w.db, w.ownerA, { cardId: card.id, reason: 'Lost' }));
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: lost.uid })))?.message).toBe('This card is blocked. Please visit the counter.');
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: 'NO-SUCH' })))?.message).toBe('Card not recognized. Verify the card or contact the counter.');
    const sus = await mkPlayer(w, w.a1, 'Suspended', 0);
    await setMemberStatus(w.db, w.ownerA, sus.member.id, 'suspended', 'Test');
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: sus.uid })))?.code).toBe('blocked_card');
  });

  it('lets a player take a chosen free seat, and refuses a taken or out-of-range seat', async () => {
    const s = await session();
    const a = await mkPlayer(w, w.a1, 'Seat Five', 0);
    expect((await seatPlayer(w.db, dealer(), { sessionId: s, uid: a.uid, seatNumber: 5 })).seatNumber).toBe(5);
    const b = await mkPlayer(w, w.a1, 'Wants Five', 0);
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: b.uid, seatNumber: 5 })))?.code).toBe('conflict');
    expect(await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: b.uid, seatNumber: 9 }))).toBeDefined();
  });

  it('a smaller table enforces its own seat count', async () => {
    const t = await createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Six Max', maxSeats: 6 });
    const s = (await openSession(w.db, dealer(), t.id)).id;
    for (let i = 0; i < 6; i++) await seated(s, `Six ${i}`, 0);
    const extra = await mkPlayer(w, w.a1, 'Seventh', 0);
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: extra.uid })))?.code).toBe('table_full');
  });

  it('cannot seat into a closed session or another outlet’s session', async () => {
    const s = await session();
    const p = await mkPlayer(w, w.a1, 'Late', 0);
    await closeSession(w.db, dealer(), s);
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: s, uid: p.uid })))?.code).toBe('conflict');
    const t = await createTable(w.db, w.ownerA, { outletId: w.a2, name: `Bandra ${key()}` });
    const other = (await openSession(w.db, w.ownerA, t.id)).id;
    expect((await errorOf(seatPlayer(w.db, dealer(), { sessionId: other, uid: p.uid })))?.code).toBe('forbidden');
  });

  it('shows the floor with seats and chips out', async () => {
    const s = await session('Floor View');
    const p = await seated(s, 'On Board', 3000);
    await chips(s, p.member.id, 500);
    const board = await tablesBoard(w.db, dealer(), w.a1);
    const row = board.find((b) => b.table.name === 'Floor View')!;
    expect(row.players).toHaveLength(1);
    expect(row.players[0]).toMatchObject({ name: 'On Board', seatNumber: 1, chipsOut: rupees(500) });
    expect((await errorOf(tablesBoard(w.db, w.staffA.cashier2, w.a1)))?.code).toBe('forbidden');
  });

  it('frees the seat when a player leaves with no chips out', async () => {
    const s = await session();
    const p = await seated(s, 'Leaver', 1000);
    await chips(s, p.member.id, 200);
    expect((await errorOf(leaveSeat(w.db, dealer(), { sessionId: s, memberId: p.member.id })))?.message).toBe('Return chips before the player leaves.');
    await returnChips(w.db, dealer(), { sessionId: s, memberId: p.member.id, amount: rupees(200), idempotencyKey: key() });
    await leaveSeat(w.db, dealer(), { sessionId: s, memberId: p.member.id });
    const next = await mkPlayer(w, w.a1, 'Takes Seat One', 0);
    expect((await seatPlayer(w.db, dealer(), { sessionId: s, uid: next.uid })).seatNumber).toBe(1);
  });
});

describe('chips', () => {
  it('issues chips against a wallet debit and records both sides', async () => {
    const s = await session();
    const p = await seated(s, 'Buyer', 5000);
    const r = await chips(s, p.member.id, 1000);
    expect(r.replayed).toBe(false);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(4000));
    const [tx] = await w.db.select().from(schema.chipTransactions).where(eq(schema.chipTransactions.memberId, p.member.id));
    expect(tx.walletLedgerId).not.toBeNull();
    const [led] = await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.id, tx.walletLedgerId!));
    expect(led.type).toBe('chip_buy_in');
    expect(led.direction).toBe('dr');
  });

  it('with a short balance issues nothing and shows the low-balance message', async () => {
    const s = await session();
    const p = await seated(s, 'Broke', 100);
    const err = await errorOf(chips(s, p.member.id, 101));
    expect(err?.message).toBe('Low balance. Please visit the counter to recharge.');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(100));
    expect((await w.db.select().from(schema.chipTransactions).where(eq(schema.chipTransactions.memberId, p.member.id))).length).toBe(0);
  });

  it('a double tap with the same key issues once, and a rapid burst never overdraws', async () => {
    const s = await session();
    const p = await seated(s, 'Tapper', 1000);
    const k = key();
    const [a, b] = await Promise.all([chips(s, p.member.id, 300, k), chips(s, p.member.id, 300, k)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(700));
    const burst = await Promise.allSettled([1, 2, 3, 4].map(() => chips(s, p.member.id, 300)));
    expect(burst.filter((x) => x.status === 'fulfilled').length).toBe(2);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(100));
  });

  it('returns chips to the wallet, never more than the player has out', async () => {
    const s = await session();
    const p = await seated(s, 'Returner', 2000);
    await chips(s, p.member.id, 1000);
    const over = await errorOf(returnChips(w.db, dealer(), { sessionId: s, memberId: p.member.id, amount: rupees(1500), idempotencyKey: key() }));
    expect(over?.code).toBe('invalid');
    await returnChips(w.db, dealer(), { sessionId: s, memberId: p.member.id, amount: rupees(600), idempotencyKey: key() });
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(1600));
    const sum = await sessionSummary(w.db, dealer(), s);
    expect(sum).toMatchObject({ issued: rupees(1000), returned: rupees(600), outstanding: rupees(400) });
  });

  it('keeps issue and return as separate events and refuses to edit them', async () => {
    const s = await session();
    const p = await seated(s, 'History', 1000);
    await chips(s, p.member.id, 500);
    await returnChips(w.db, dealer(), { sessionId: s, memberId: p.member.id, amount: rupees(500), idempotencyKey: key() });
    const rows = await w.db.select().from(schema.chipTransactions).where(eq(schema.chipTransactions.sessionId, s));
    expect(rows.map((r) => r.type).sort()).toEqual(['issue', 'return']);
    expect(await errorOf(w.db.update(schema.chipTransactions).set({ amount: 1 }).where(eq(schema.chipTransactions.id, rows[0].id)))).toBeDefined();
  });

  it('rejects players who are not seated, blocked cards mid-session, and bad amounts', async () => {
    const s = await session();
    const outsider = await mkPlayer(w, w.a1, 'Not Seated', 1000);
    expect((await errorOf(chips(s, outsider.member.id, 100)))?.code).toBe('invalid');
    const p = await seated(s, 'Blocked Later', 1000);
    const [card] = await w.db.select().from(schema.cards).where(eq(schema.cards.uid, p.uid));
    await blockCard(w.db, w.ownerA, { cardId: card.id, reason: 'Lost mid session' });
    expect((await errorOf(chips(s, p.member.id, 100)))?.message).toBe('This card is blocked. Please visit the counter.');
    const q = await seated(s, 'Bad Amount', 1000);
    for (const amount of [0, -5, 1.5]) {
      expect(await errorOf(issueChips(w.db, dealer(), { sessionId: s, memberId: q.member.id, amount, idempotencyKey: key() }))).toBeDefined();
    }
  });

  it('only dealers and owners move chips', async () => {
    const s = await session();
    const p = await seated(s, 'Guarded', 1000);
    for (const ctx of [w.staffA.cashier, w.staffA.waiter, w.staffA.kds]) {
      expect((await errorOf(issueChips(w.db, ctx, { sessionId: s, memberId: p.member.id, amount: 100, idempotencyKey: key() })))?.code).toBe('forbidden');
    }
    expect((await errorOf(issueChips(w.db, w.ownerB, { sessionId: s, memberId: p.member.id, amount: 100, idempotencyKey: key() })))?.code).toBe('forbidden');
  });

  it('debits the outlet’s wallet, so another outlet’s balance is untouched', async () => {
    const s = await session();
    const p = await seated(s, 'Two Outlet Buyer', 1000);
    const { fund } = await import('./helpers');
    await fund(w, w.a2, p.member.id, 700);
    await chips(s, p.member.id, 400);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(600));
    expect(await balanceOf(w.db, p.member.id, w.a2)).toBe(rupees(700));
  });
});

describe('rounds', () => {
  async function setup() {
    const s = await session();
    const a = await seated(s, 'Alpha', 0);
    const b = await seated(s, 'Bravo', 0);
    const c = await seated(s, 'Charlie', 0);
    return { s, a, b, c };
  }

  it('numbers rounds in sequence as drafts, and submitting freezes them', async () => {
    const { s, a, b } = await setup();
    const r1 = await createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id, b.member.id], winnerMemberId: a.member.id, pot: rupees(900) });
    const r2 = await createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id], submit: true });
    expect([r1.roundNumber, r2.roundNumber]).toEqual([1, 2]);
    expect(r1.status).toBe('draft');
    const edited = await updateDraftRound(w.db, dealer(), r1.id, { winnerMemberId: b.member.id, pot: rupees(950) });
    expect(edited.winnerMemberId).toBe(b.member.id);
    const sub = await submitRound(w.db, dealer(), r1.id);
    expect(sub.status).toBe('submitted');
    expect(sub.submittedAt).not.toBeNull();
    const err = await errorOf(updateDraftRound(w.db, dealer(), r1.id, { pot: 1 }));
    expect(err?.code).toBe('conflict');
    expect(err?.message).toContain('Submitted rounds cannot be edited');
  });

  it('creates unique round numbers under concurrent entry', async () => {
    const { s, a } = await setup();
    const settled = await Promise.allSettled([1, 2, 3].map(() => createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id] })));
    expect(settled.every((x) => x.status === 'fulfilled')).toBe(true);
    const rows = await w.db.select().from(schema.rounds).where(eq(schema.rounds.sessionId, s));
    expect(rows.map((r) => r.roundNumber).sort()).toEqual([1, 2, 3]);
  });

  it('only seated players take part and the winner must be a participant', async () => {
    const { s, a, b } = await setup();
    const outsider = await mkPlayer(w, w.a1, 'Not At Table', 0);
    expect((await errorOf(createRound(w.db, dealer(), { sessionId: s, participants: [outsider.member.id] })))?.code).toBe('invalid');
    expect((await errorOf(createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id], winnerMemberId: b.member.id })))?.code).toBe('invalid');
    expect(await errorOf(createRound(w.db, dealer(), { sessionId: s, participants: [] }))).toBeDefined();
  });

  it('owner corrections keep the original values, actor and reason', async () => {
    const { s, a, b } = await setup();
    const r = await createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id, b.member.id], winnerMemberId: a.member.id, pot: rupees(500), submit: true });
    expect((await errorOf(correctRound(w.db, dealer(), r.id, { winnerMemberId: b.member.id, reason: 'oops' })))?.code).toBe('forbidden');
    expect((await errorOf(correctRound(w.db, w.ownerA, r.id, { winnerMemberId: b.member.id, reason: ' ' })))?.code).toBe('invalid');
    const fixed = await correctRound(w.db, w.ownerA, r.id, { winnerMemberId: b.member.id, pot: rupees(550), reason: 'Entered against the wrong seat' });
    expect(fixed.winnerMemberId).toBe(b.member.id);
    const [round] = await listRounds(w.db, w.ownerA, s);
    expect(round.corrections).toHaveLength(1);
    expect(round.corrections[0]).toMatchObject({ reason: 'Entered against the wrong seat', actorId: w.ownerA.userId });
    expect(round.corrections[0].before).toMatchObject({ winnerMemberId: a.member.id, pot: rupees(500) });
    expect(round.corrections[0].after).toMatchObject({ winnerMemberId: b.member.id, pot: rupees(550) });
    const trail = await listAudit(w.db, w.ownerA, { category: 'Rounds' });
    expect(trail.some((t) => t.action === 'Round corrected')).toBe(true);
  });

  it('a draft needs editing, not a correction, and correction logs cannot be changed', async () => {
    const { s, a } = await setup();
    const r = await createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id] });
    expect((await errorOf(correctRound(w.db, w.ownerA, r.id, { pot: 1, reason: 'x' })))?.code).toBe('conflict');
    const done = await createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id], submit: true });
    await correctRound(w.db, w.ownerA, done.id, { pot: 5, reason: 'typo' });
    expect(await errorOf(w.db.delete(schema.roundCorrections))).toBeDefined();
  });

  it('a closed session’s rounds are read-only for dealers', async () => {
    const { s, a } = await setup();
    const r = await createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id], submit: true });
    await returnAll(s);
    await closeSession(w.db, dealer(), s);
    expect((await errorOf(createRound(w.db, dealer(), { sessionId: s, participants: [a.member.id] })))?.code).toBe('conflict');
    expect(r.status).toBe('submitted');
  });
});

async function returnAll(sessionId: string) {
  const sum = await sessionSummary(w.db, dealer(), sessionId);
  for (const [memberId, v] of Object.entries(sum.perMember)) {
    const out = v.issued - v.returned;
    if (out > 0) await returnChips(w.db, dealer(), { sessionId, memberId, amount: out, idempotencyKey: key() });
  }
}

describe('settlement', () => {
  it('closes cleanly when every chip is back, and frees the players', async () => {
    const s = await session();
    const p = await seated(s, 'Clean Close', 1000);
    await chips(s, p.member.id, 400);
    await returnChips(w.db, dealer(), { sessionId: s, memberId: p.member.id, amount: rupees(400), idempotencyKey: key() });
    const closed = await closeSession(w.db, dealer(), s);
    expect(closed.status).toBe('completed');
    expect(closed.exceptionAmount).toBe(0);
    expect(closed.endedAt).not.toBeNull();
    const [row] = await w.db.select().from(schema.sessionPlayers).where(eq(schema.sessionPlayers.memberId, p.member.id));
    expect(row.status).toBe('left');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(1000));
  });

  it('records chips still out as an exception that needs a note, then the owner resolves it', async () => {
    const s = await session();
    const p = await seated(s, 'Walks Off', 1000);
    await chips(s, p.member.id, 700);
    expect((await errorOf(closeSession(w.db, dealer(), s)))?.message).toContain('Chips are still out');
    const closed = await closeSession(w.db, dealer(), s, { exceptionNote: 'Player left with chips, will settle tomorrow' });
    expect(closed.exceptionAmount).toBe(rupees(700));
    expect(closed.exceptionNote).toContain('settle tomorrow');
    expect((await errorOf(resolveException(w.db, dealer(), s, 'done')))?.code).toBe('forbidden');
    expect((await errorOf(resolveException(w.db, w.ownerA, s, ' ')))?.code).toBe('invalid');
    const done = await resolveException(w.db, w.ownerA, s, 'Chips returned the next day');
    expect(done.exceptionResolvedAt).not.toBeNull();
    expect((await errorOf(resolveException(w.db, w.ownerA, s, 'again')))?.code).toBe('conflict');
  });

  it('cannot close with a draft round open, and a closed session is final', async () => {
    const s = await session();
    const p = await seated(s, 'Draft Holder', 0);
    await createRound(w.db, dealer(), { sessionId: s, participants: [p.member.id] });
    expect((await errorOf(closeSession(w.db, dealer(), s)))?.message).toContain('draft round');
    const rounds = await w.db.select().from(schema.rounds).where(eq(schema.rounds.sessionId, s));
    await submitRound(w.db, dealer(), rounds[0].id);
    await closeSession(w.db, dealer(), s);
    expect((await errorOf(closeSession(w.db, dealer(), s)))?.code).toBe('conflict');
    expect((await errorOf(issueChips(w.db, dealer(), { sessionId: s, memberId: p.member.id, amount: 100, idempotencyKey: key() })))?.code).toBe('conflict');
  });

  it('writes chip movements and settlement to the audit trail', async () => {
    const actions = (await listAudit(w.db, w.ownerA, { category: 'Chips' })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['Chips issued', 'Chips returned', 'Session closed', 'Session closed with exception', 'Chip exception resolved', 'Player seated']));
  });
});
