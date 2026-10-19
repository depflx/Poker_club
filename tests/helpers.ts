import { issueCard } from '@/server/cards';
import { createMember } from '@/server/members';
import { recordPayment } from '@/server/payments';
import { rupees } from '@/lib/money';
import { createPgliteDb, schema, type DB } from '@/db/client';
import { buildCtx, hashPassword } from '@/server/auth';
import { createOutlet } from '@/server/outlets';
import { createStaff } from '@/server/staff';
import { createOwner } from '@/server/superadmin';
import type { Ctx } from '@/lib/permissions';

export const PASSWORD = 'password123';

export async function newDb(): Promise<DB> {
  return createPgliteDb();
}

export async function seedSuperadmin(db: DB, email = 'root@depflx.test') {
  const [u] = await db
    .insert(schema.users)
    .values({ email, name: 'DepFlx Root', passwordHash: await hashPassword(PASSWORD), role: 'superadmin' })
    .returning();
  return u;
}

async function staffCtx(db: DB, owner: Ctx, role: 'cashier' | 'dealer' | 'waiter' | 'kds', outletIds: string[], tag: string) {
  const u = await createStaff(db, owner, { name: `${role} ${tag}`, email: `${role}.${tag}@club.test`, role, password: PASSWORD, outletIds });
  return buildCtx(db, u.id);
}

/**
 * Two owners. Owner A runs two outlets (a1, a2) with one of every staff role on a1 and a cashier on a2.
 * Owner B runs one outlet. Used to prove isolation between outlets and between owners.
 */
export async function world() {
  const db = await newDb();
  const saUser = await seedSuperadmin(db);
  const sa = await buildCtx(db, saUser.id);

  const A = await createOwner(db, sa, {
    name: 'Club A', plan: 'pro', outletLimit: 3, ownerName: 'Priya', ownerEmail: 'priya@a.test', password: PASSWORD,
    firstOutlet: { name: 'Andheri', code: 'AND' },
  });
  let ownerA = await buildCtx(db, A.ownerUser.id);
  const a1 = A.outletId!;
  const a2 = (await createOutlet(db, ownerA, { name: 'Bandra', code: 'BAN' })).id;
  ownerA = await buildCtx(db, A.ownerUser.id);

  const staffA = {
    cashier: await staffCtx(db, ownerA, 'cashier', [a1], 'a1'),
    cashier2: await staffCtx(db, ownerA, 'cashier', [a2], 'a2'),
    dealer: await staffCtx(db, ownerA, 'dealer', [a1], 'a1'),
    waiter: await staffCtx(db, ownerA, 'waiter', [a1], 'a1'),
    kds: await staffCtx(db, ownerA, 'kds', [a1], 'a1'),
  };

  const B = await createOwner(db, sa, {
    name: 'Club B', plan: 'standard', outletLimit: 1, ownerName: 'Bob', ownerEmail: 'bob@b.test', password: PASSWORD,
    firstOutlet: { name: 'Pune', code: 'PUN' },
  });
  const ownerB = await buildCtx(db, B.ownerUser.id);
  const b1 = B.outletId!;
  const cashierB = await staffCtx(db, ownerB, 'cashier', [b1], 'b1');

  return { db, sa, saUser, A, B, ownerA, ownerB, a1, a2, b1, staffA, cashierB };
}

export type World = Awaited<ReturnType<typeof world>>;

/** Runs a promise and returns the AppError message (or undefined if it did not throw). */
export async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string } | undefined> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  return undefined;
}

// ---------- builders used by the floor, wallet and food tests ----------
let counter = 0;
export const key = () => `key-${Date.now()}-${++counter}`;

/** Registers a member, issues a card and loads the wallet at one outlet. The owner context avoids shift setup. */
export async function mkPlayer(w: World, outletId: string, name: string, balanceRs = 0, opts: { ctx?: Ctx } = {}) {
  const ctx = opts.ctx ?? w.ownerA;
  const n = ++counter;
  const member = await createMember(w.db, ctx, { outletId, name, mobile: `9${String(100000000 + n).slice(0, 9)}` });
  const uid = `UID-${String(n).padStart(6, '0')}`;
  await issueCard(w.db, ctx, { outletId, memberId: member.id, uid, method: 'cash', idempotencyKey: key() });
  if (balanceRs > 0) await fund(w, outletId, member.id, balanceRs, ctx);
  return { member, uid };
}

export async function fund(w: World, outletId: string, memberId: string, rs: number, ctx: Ctx = w.ownerA) {
  return recordPayment(w.db, ctx, { outletId, memberId, amount: rupees(rs), method: 'cash', purpose: 'recharge', idempotencyKey: key() });
}
