import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { can, requireOutlet, requirePerm, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import { lookupCard } from './cards';
import type { Q, Tx } from './db-types';
import { postLedger } from './wallet';

const { pokerTables, pokerSessions, sessionPlayers, chipTransactions, rounds, roundCorrections, members, cards } = schema;

/** Reads the constraint name from a Postgres unique violation, however the driver wraps it. */
function violated(e: unknown): string | null {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string }; message?: string };
  const code = err.code ?? err.cause?.code;
  if (code !== '23505') return null;
  return err.constraint ?? err.cause?.constraint ?? err.message ?? 'unique';
}

// ---------- tables ----------
const CreateTable = z.object({
  outletId: z.string().uuid(),
  name: z.string().trim().min(1),
  maxSeats: z.number().int().min(2).max(8).default(8),
});

export async function createTable(db: DB, ctx: Ctx, raw: z.input<typeof CreateTable>) {
  requirePerm(ctx, 'tables.manage');
  const input = CreateTable.parse(raw);
  requireOutlet(ctx, input.outletId);
  return db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: pokerTables.id })
      .from(pokerTables)
      .where(and(eq(pokerTables.outletId, input.outletId), eq(pokerTables.name, input.name)));
    if (dup) throw new AppError('conflict', 'A table with that name already exists.');
    const [t] = await tx.insert(pokerTables).values(input).returning();
    await audit(tx, ctx, {
      category: 'Chips', action: 'Table created', entityType: 'table', entityId: t.id, outletId: input.outletId,
      after: { name: t.name, maxSeats: t.maxSeats },
    });
    return t;
  });
}

export async function updateTable(db: DB, ctx: Ctx, tableId: string, patch: { name?: string; maxSeats?: number; active?: boolean }) {
  requirePerm(ctx, 'tables.manage');
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(pokerTables).where(eq(pokerTables.id, tableId)).for('update');
    if (!before) throw new AppError('not_found', 'Table not found.');
    requireOutlet(ctx, before.outletId);
    if (patch.maxSeats !== undefined) z.number().int().min(2).max(8).parse(patch.maxSeats);
    const [open] = await tx
      .select({ id: pokerSessions.id })
      .from(pokerSessions)
      .where(and(eq(pokerSessions.tableId, tableId), eq(pokerSessions.status, 'in_progress')));
    if (open && (patch.active === false || patch.maxSeats !== undefined)) {
      throw new AppError('conflict', 'Close the running session before changing this table.');
    }
    const [after] = await tx
      .update(pokerTables)
      .set({ name: patch.name?.trim() || before.name, maxSeats: patch.maxSeats ?? before.maxSeats, active: patch.active ?? before.active })
      .where(eq(pokerTables.id, tableId))
      .returning();
    await audit(tx, ctx, {
      category: 'Chips', action: 'Table updated', entityType: 'table', entityId: tableId, outletId: before.outletId,
      before: { name: before.name, maxSeats: before.maxSeats, active: before.active },
      after: { name: after.name, maxSeats: after.maxSeats, active: after.active },
    });
    return after;
  });
}

async function outstandingByMember(q: Q, sessionId: string) {
  const rows = await q.select().from(chipTransactions).where(eq(chipTransactions.sessionId, sessionId));
  const map = new Map<string, { issued: number; returned: number }>();
  for (const r of rows) {
    const cur = map.get(r.memberId) ?? { issued: 0, returned: 0 };
    if (r.type === 'issue') cur.issued += r.amount;
    else cur.returned += r.amount;
    map.set(r.memberId, cur);
  }
  return map;
}

/** Floor view for one outlet: every table, its open session, who is seated and chips out. */
export async function tablesBoard(db: DB, ctx: Ctx, outletId: string) {
  if (!['floor.operate', 'tables.manage', 'food.order'].some((p) => can(ctx, p))) requirePerm(ctx, 'floor.operate');
  requireOutlet(ctx, outletId);
  const tables = await db.select().from(pokerTables).where(eq(pokerTables.outletId, outletId)).orderBy(asc(pokerTables.name));
  const open = await db
    .select()
    .from(pokerSessions)
    .where(and(eq(pokerSessions.outletId, outletId), eq(pokerSessions.status, 'in_progress')));
  const players = open.length
    ? await db
        .select({ sp: sessionPlayers, name: members.name, number: members.memberNumber, tier: members.tier })
        .from(sessionPlayers)
        .innerJoin(members, eq(members.id, sessionPlayers.memberId))
        .where(and(inArray(sessionPlayers.sessionId, open.map((s) => s.id)), eq(sessionPlayers.status, 'active')))
    : [];
  const result = [];
  for (const t of tables) {
    const session = open.find((s) => s.tableId === t.id) ?? null;
    const out = session ? await outstandingByMember(db, session.id) : new Map();
    result.push({
      table: t,
      session,
      players: players
        .filter((p) => p.sp.sessionId === session?.id)
        .sort((a, b) => a.sp.seatNumber - b.sp.seatNumber)
        .map((p) => {
          const o = out.get(p.sp.memberId) ?? { issued: 0, returned: 0 };
          return {
            memberId: p.sp.memberId, name: p.name, memberNumber: p.number, tier: p.tier,
            seatNumber: p.sp.seatNumber, chipsOut: o.issued - o.returned,
          };
        }),
    });
  }
  return result;
}

// ---------- sessions ----------
export async function openSession(db: DB, ctx: Ctx, tableId: string) {
  requirePerm(ctx, 'floor.operate');
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(pokerTables).where(eq(pokerTables.id, tableId)).for('update');
    if (!t) throw new AppError('not_found', 'Table not found.');
    requireOutlet(ctx, t.outletId);
    if (!t.active) throw new AppError('conflict', 'This table is not in use.');
    const [open] = await tx
      .select({ id: pokerSessions.id })
      .from(pokerSessions)
      .where(and(eq(pokerSessions.tableId, tableId), eq(pokerSessions.status, 'in_progress')));
    if (open) throw new AppError('conflict', 'This table already has a running session.');
    const [s] = await tx.insert(pokerSessions).values({ outletId: t.outletId, tableId, operatorId: ctx.userId }).returning();
    await audit(tx, ctx, {
      category: 'Chips', action: 'Session started', entityType: 'session', entityId: s.id, outletId: t.outletId,
      after: { table: t.name },
    });
    return s;
  });
}

async function lockOpenSession(tx: Tx, ctx: Ctx, sessionId: string) {
  const [s] = await tx.select().from(pokerSessions).where(eq(pokerSessions.id, sessionId)).for('update');
  if (!s) throw new AppError('not_found', 'Session not found.');
  requireOutlet(ctx, s.outletId);
  if (s.status !== 'in_progress') throw new AppError('conflict', 'This session is closed and read-only.');
  return s;
}

const Seat = z.object({
  sessionId: z.string().uuid(),
  uid: z.string().trim().min(1),
  seatNumber: z.number().int().min(1).max(8).optional(),
});

/** Seats a player by card tap. Capacity and one-seat-per-player are enforced by the database as well. */
export async function seatPlayer(db: DB, ctx: Ctx, raw: z.input<typeof Seat>) {
  requirePerm(ctx, 'floor.operate');
  const input = Seat.parse(raw);
  try {
    return await db.transaction(async (tx) => {
      const s = await lockOpenSession(tx, ctx, input.sessionId);
      const [table] = await tx.select().from(pokerTables).where(eq(pokerTables.id, s.tableId));
      const { member } = await lookupCard(tx, ctx, input.uid);
      const [seated] = await tx
        .select()
        .from(sessionPlayers)
        .where(and(eq(sessionPlayers.memberId, member.id), eq(sessionPlayers.status, 'active')));
      if (seated) throw new AppError('already_seated');

      const taken = (
        await tx
          .select({ n: sessionPlayers.seatNumber })
          .from(sessionPlayers)
          .where(and(eq(sessionPlayers.sessionId, s.id), eq(sessionPlayers.status, 'active')))
      ).map((r) => r.n);
      if (taken.length >= table.maxSeats) throw new AppError('table_full');
      let seat = input.seatNumber;
      if (seat !== undefined) {
        if (seat > table.maxSeats) throw new AppError('invalid', `This table has ${table.maxSeats} seats.`);
        if (taken.includes(seat)) throw new AppError('conflict', `Seat ${seat} is taken.`);
      } else {
        seat = Array.from({ length: table.maxSeats }, (_, i) => i + 1).find((n) => !taken.includes(n));
      }
      const [row] = await tx.insert(sessionPlayers).values({ sessionId: s.id, memberId: member.id, seatNumber: seat! }).returning();
      await audit(tx, ctx, {
        category: 'Chips', action: 'Player seated', entityType: 'session', entityId: s.id, outletId: s.outletId,
        after: { memberId: member.id, seat },
      });
      return { ...row, memberName: member.name };
    });
  } catch (e) {
    const v = violated(e);
    if (v?.includes('member_one_active_seat')) throw new AppError('already_seated');
    if (v?.includes('seat_unique_active')) throw new AppError('table_full');
    throw e;
  }
}

async function activePlayer(tx: Tx, sessionId: string, memberId: string) {
  const [p] = await tx
    .select()
    .from(sessionPlayers)
    .where(and(eq(sessionPlayers.sessionId, sessionId), eq(sessionPlayers.memberId, memberId), eq(sessionPlayers.status, 'active')));
  if (!p) throw new AppError('invalid', 'That player is not seated in this session.');
  return p;
}

export async function leaveSeat(db: DB, ctx: Ctx, input: { sessionId: string; memberId: string }) {
  requirePerm(ctx, 'floor.operate');
  return db.transaction(async (tx) => {
    const s = await lockOpenSession(tx, ctx, input.sessionId);
    const p = await activePlayer(tx, s.id, input.memberId);
    const o = (await outstandingByMember(tx, s.id)).get(input.memberId) ?? { issued: 0, returned: 0 };
    if (o.issued - o.returned > 0) throw new AppError('invalid', 'Return chips before the player leaves.');
    await tx.update(sessionPlayers).set({ status: 'left', leftAt: new Date() }).where(eq(sessionPlayers.id, p.id));
    await audit(tx, ctx, {
      category: 'Chips', action: 'Player left', entityType: 'session', entityId: s.id, outletId: s.outletId,
      after: { memberId: input.memberId, seat: p.seatNumber },
    });
    return { ...p, status: 'left' };
  });
}

// ---------- chips ----------
const ChipMove = z.object({
  sessionId: z.string().uuid(),
  memberId: z.string().uuid(),
  amount: z.number().int().positive('Enter a chip amount above zero.'),
  idempotencyKey: z.string().min(8),
});

async function moveChips(db: DB, ctx: Ctx, raw: z.input<typeof ChipMove>, type: 'issue' | 'return') {
  requirePerm(ctx, 'chips.move');
  const input = ChipMove.parse(raw);
  return db.transaction(async (tx) => {
    const s = await lockOpenSession(tx, ctx, input.sessionId);
    const [dup] = await tx
      .select()
      .from(chipTransactions)
      .where(and(eq(chipTransactions.outletId, s.outletId), eq(chipTransactions.idempotencyKey, input.idempotencyKey)));
    if (dup) return { chip: dup, replayed: true };

    await activePlayer(tx, s.id, input.memberId);
    const [member] = await tx.select().from(members).where(eq(members.id, input.memberId));
    if (member.status !== 'active') throw new AppError('blocked_card', 'This member is not active. Please visit the counter.');
    const [card] = await tx.select().from(cards).where(and(eq(cards.memberId, member.id), eq(cards.status, 'active')));
    if (!card) throw new AppError('blocked_card');

    const o = (await outstandingByMember(tx, s.id)).get(member.id) ?? { issued: 0, returned: 0 };
    if (type === 'return' && input.amount > o.issued - o.returned) {
      throw new AppError('invalid', 'That is more than the chips this player has out.');
    }
    const { entry } = await postLedger(tx, {
      outletId: s.outletId,
      memberId: member.id,
      type: type === 'issue' ? 'chip_buy_in' : 'chip_return',
      direction: type === 'issue' ? 'dr' : 'cr',
      amount: input.amount,
      refType: 'session',
      refId: s.id,
      actorId: ctx.userId,
      idempotencyKey: `chip:${input.idempotencyKey}`,
    });
    const [chip] = await tx
      .insert(chipTransactions)
      .values({
        sessionId: s.id, outletId: s.outletId, memberId: member.id, type, amount: input.amount,
        walletLedgerId: entry.id, actorId: ctx.userId, idempotencyKey: input.idempotencyKey,
      })
      .returning();
    await audit(tx, ctx, {
      category: 'Chips', action: type === 'issue' ? 'Chips issued' : 'Chips returned', entityType: 'chip_transaction',
      entityId: chip.id, outletId: s.outletId,
      after: { memberId: member.id, amount: input.amount, balanceAfter: entry.balanceAfter },
    });
    return { chip, replayed: false, balanceAfter: entry.balanceAfter };
  });
}

/** Issues chips against a wallet debit. If the balance is short, nothing is issued. */
export const issueChips = (db: DB, ctx: Ctx, raw: z.input<typeof ChipMove>) => moveChips(db, ctx, raw, 'issue');
/** Takes chips back and credits the wallet. Cannot exceed what the player has out. */
export const returnChips = (db: DB, ctx: Ctx, raw: z.input<typeof ChipMove>) => moveChips(db, ctx, raw, 'return');

// ---------- rounds ----------
const RoundInput = z.object({
  sessionId: z.string().uuid(),
  participants: z.array(z.string().uuid()).min(1, 'Pick at least one player.'),
  winnerMemberId: z.string().uuid().nullable().optional(),
  pot: z.number().int().min(0).default(0),
  notes: z.string().trim().optional(),
  submit: z.boolean().default(false),
});

async function assertSeated(tx: Tx, sessionId: string, ids: string[]) {
  const seated = (
    await tx
      .select({ id: sessionPlayers.memberId })
      .from(sessionPlayers)
      .where(and(eq(sessionPlayers.sessionId, sessionId), eq(sessionPlayers.status, 'active')))
  ).map((r) => r.id);
  if (ids.some((id) => !seated.includes(id))) throw new AppError('invalid', 'Every player in a round must be seated at this table.');
}

export async function createRound(db: DB, ctx: Ctx, raw: z.input<typeof RoundInput>) {
  requirePerm(ctx, 'rounds.write');
  const input = RoundInput.parse(raw);
  return db.transaction(async (tx) => {
    const s = await lockOpenSession(tx, ctx, input.sessionId);
    const participants = [...new Set(input.participants)];
    await assertSeated(tx, s.id, participants);
    if (input.winnerMemberId && !participants.includes(input.winnerMemberId)) {
      throw new AppError('invalid', 'The winner must be one of the players in the round.');
    }
    const [{ n }] = await tx
      .select({ n: sql<number>`coalesce(max(${rounds.roundNumber}), 0)::int` })
      .from(rounds)
      .where(eq(rounds.sessionId, s.id));
    const [r] = await tx
      .insert(rounds)
      .values({
        sessionId: s.id, outletId: s.outletId, roundNumber: n + 1, participants,
        winnerMemberId: input.winnerMemberId ?? null, pot: input.pot, notes: input.notes,
        status: input.submit ? 'submitted' : 'draft', submittedAt: input.submit ? new Date() : null, enteredBy: ctx.userId,
      })
      .returning();
    await audit(tx, ctx, {
      category: 'Rounds', action: input.submit ? 'Round submitted' : 'Round drafted', entityType: 'round', entityId: r.id,
      outletId: s.outletId, after: { roundNumber: r.roundNumber, winner: r.winnerMemberId, pot: r.pot },
    });
    return r;
  });
}

async function lockRound(tx: Tx, ctx: Ctx, roundId: string) {
  const [r] = await tx.select().from(rounds).where(eq(rounds.id, roundId)).for('update');
  if (!r) throw new AppError('not_found', 'Round not found.');
  requireOutlet(ctx, r.outletId);
  return r;
}

export async function updateDraftRound(
  db: DB, ctx: Ctx, roundId: string,
  patch: { participants?: string[]; winnerMemberId?: string | null; pot?: number; notes?: string },
) {
  requirePerm(ctx, 'rounds.write');
  return db.transaction(async (tx) => {
    const r = await lockRound(tx, ctx, roundId);
    if (r.status !== 'draft') throw new AppError('conflict', 'Submitted rounds cannot be edited. Ask the owner for a correction.');
    const participants = patch.participants ? [...new Set(patch.participants)] : r.participants;
    await assertSeated(tx, r.sessionId, participants);
    const winner = patch.winnerMemberId === undefined ? r.winnerMemberId : patch.winnerMemberId;
    if (winner && !participants.includes(winner)) throw new AppError('invalid', 'The winner must be one of the players in the round.');
    const [after] = await tx
      .update(rounds)
      .set({ participants, winnerMemberId: winner, pot: patch.pot ?? r.pot, notes: patch.notes ?? r.notes })
      .where(eq(rounds.id, roundId))
      .returning();
    return after;
  });
}

export async function submitRound(db: DB, ctx: Ctx, roundId: string) {
  requirePerm(ctx, 'rounds.write');
  return db.transaction(async (tx) => {
    const r = await lockRound(tx, ctx, roundId);
    if (r.status === 'submitted') return r;
    const [after] = await tx.update(rounds).set({ status: 'submitted', submittedAt: new Date() }).where(eq(rounds.id, roundId)).returning();
    await audit(tx, ctx, {
      category: 'Rounds', action: 'Round submitted', entityType: 'round', entityId: roundId, outletId: r.outletId,
      after: { roundNumber: r.roundNumber, winner: r.winnerMemberId, pot: r.pot },
    });
    return after;
  });
}

/** Owner correction of a submitted round. The original values stay on record. */
export async function correctRound(
  db: DB, ctx: Ctx, roundId: string,
  input: { winnerMemberId?: string | null; pot?: number; notes?: string; reason: string },
) {
  requirePerm(ctx, 'round.correct');
  if (!input.reason?.trim()) throw new AppError('invalid', 'Give a reason for the correction.');
  return db.transaction(async (tx) => {
    const r = await lockRound(tx, ctx, roundId);
    if (r.status !== 'submitted') throw new AppError('conflict', 'Only a submitted round needs a correction. Edit the draft instead.');
    const winner = input.winnerMemberId === undefined ? r.winnerMemberId : input.winnerMemberId;
    if (winner && !r.participants.includes(winner)) throw new AppError('invalid', 'The winner must be one of the players in the round.');
    const before = { winnerMemberId: r.winnerMemberId, pot: r.pot, notes: r.notes };
    const after = { winnerMemberId: winner, pot: input.pot ?? r.pot, notes: input.notes ?? r.notes };
    await tx.insert(roundCorrections).values({ roundId, before, after, reason: input.reason, actorId: ctx.userId });
    const [row] = await tx.update(rounds).set(after).where(eq(rounds.id, roundId)).returning();
    await audit(tx, ctx, {
      category: 'Rounds', action: 'Round corrected', entityType: 'round', entityId: roundId, outletId: r.outletId,
      before, after, reason: input.reason,
    });
    return row;
  });
}

export async function listRounds(db: DB, ctx: Ctx, sessionId: string) {
  if (!can(ctx, 'rounds.write')) requirePerm(ctx, 'round.correct');
  const [s] = await db.select().from(pokerSessions).where(eq(pokerSessions.id, sessionId));
  if (!s) throw new AppError('not_found', 'Session not found.');
  requireOutlet(ctx, s.outletId);
  const rs = await db.select().from(rounds).where(eq(rounds.sessionId, sessionId)).orderBy(desc(rounds.roundNumber));
  const corr = rs.length ? await db.select().from(roundCorrections).where(inArray(roundCorrections.roundId, rs.map((r) => r.id))) : [];
  return rs.map((r) => ({ ...r, corrections: corr.filter((c) => c.roundId === r.id) }));
}

// ---------- close and reconcile ----------
export async function sessionSummary(db: DB, ctx: Ctx, sessionId: string) {
  if (!can(ctx, 'floor.operate')) requirePerm(ctx, 'tables.manage');
  const [s] = await db.select().from(pokerSessions).where(eq(pokerSessions.id, sessionId));
  if (!s) throw new AppError('not_found', 'Session not found.');
  requireOutlet(ctx, s.outletId);
  const out = await outstandingByMember(db, sessionId);
  let issued = 0;
  let returned = 0;
  for (const v of out.values()) {
    issued += v.issued;
    returned += v.returned;
  }
  return { session: s, issued, returned, outstanding: issued - returned, perMember: Object.fromEntries(out) };
}

/** Closes the session. Chips still out are logged as a reconciliation exception with a required note. */
export async function closeSession(db: DB, ctx: Ctx, sessionId: string, input: { exceptionNote?: string } = {}) {
  requirePerm(ctx, 'session.settle');
  return db.transaction(async (tx) => {
    const s = await lockOpenSession(tx, ctx, sessionId);
    const [draft] = await tx
      .select({ id: rounds.id })
      .from(rounds)
      .where(and(eq(rounds.sessionId, s.id), eq(rounds.status, 'draft')))
      .limit(1);
    if (draft) throw new AppError('invalid', 'Submit the draft round before closing the session.');
    const out = await outstandingByMember(tx, s.id);
    let outstanding = 0;
    for (const v of out.values()) outstanding += v.issued - v.returned;
    if (outstanding > 0 && !input.exceptionNote?.trim()) {
      throw new AppError('invalid', 'Chips are still out. Add a note to record the exception.');
    }
    await tx
      .update(sessionPlayers)
      .set({ status: 'left', leftAt: new Date() })
      .where(and(eq(sessionPlayers.sessionId, s.id), eq(sessionPlayers.status, 'active')));
    const [after] = await tx
      .update(pokerSessions)
      .set({
        status: 'completed', endedAt: new Date(),
        exceptionAmount: outstanding > 0 ? outstanding : 0, exceptionNote: outstanding > 0 ? input.exceptionNote!.trim() : null,
      })
      .where(eq(pokerSessions.id, s.id))
      .returning();
    await audit(tx, ctx, {
      category: 'Chips', action: outstanding > 0 ? 'Session closed with exception' : 'Session closed', entityType: 'session',
      entityId: s.id, outletId: s.outletId, after: { outstanding }, reason: input.exceptionNote,
    });
    return after;
  });
}

/** Owner records how a chip exception was settled. */
export async function resolveException(db: DB, ctx: Ctx, sessionId: string, resolution: string) {
  requirePerm(ctx, 'session.settle');
  requirePerm(ctx, 'shift.approve');
  if (!resolution?.trim()) throw new AppError('invalid', 'Say how this was resolved.');
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(pokerSessions).where(eq(pokerSessions.id, sessionId)).for('update');
    if (!s) throw new AppError('not_found', 'Session not found.');
    requireOutlet(ctx, s.outletId);
    if (s.exceptionAmount <= 0) throw new AppError('conflict', 'This session has no exception.');
    if (s.exceptionResolvedAt) throw new AppError('conflict', 'This exception is already resolved.');
    const [after] = await tx
      .update(pokerSessions)
      .set({ exceptionResolvedAt: new Date(), exceptionResolution: resolution.trim() })
      .where(eq(pokerSessions.id, sessionId))
      .returning();
    await audit(tx, ctx, {
      category: 'Chips', action: 'Chip exception resolved', entityType: 'session', entityId: sessionId,
      outletId: s.outletId, reason: resolution,
    });
    return after;
  });
}

