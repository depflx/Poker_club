import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requirePerm, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import { assertStrongPassword, hashPassword } from './auth';

const { owners, outlets, outletSettings, users, authSessions } = schema;

const CreateOwner = z.object({
  name: z.string().trim().min(2),
  plan: z.enum(['trial', 'standard', 'pro']).default('trial'),
  outletLimit: z.number().int().min(1).max(50).default(1),
  ownerName: z.string().trim().min(2),
  ownerEmail: z.string().trim().toLowerCase().email(),
  password: z.string(),
  firstOutlet: z.object({ name: z.string().trim().min(2), code: z.string().trim().min(2).max(8) }).optional(),
});
export type CreateOwnerInput = z.input<typeof CreateOwner>;

/** Onboards a club owner: the tenant, its owner login and, optionally, the first outlet. */
export async function createOwner(db: DB, ctx: Ctx, raw: CreateOwnerInput) {
  requirePerm(ctx, 'platform.owners');
  const input = CreateOwner.parse(raw);
  assertStrongPassword(input.password);
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.ownerEmail));
    if (dup) throw new AppError('conflict', 'That email is already in use.');

    const [owner] = await tx
      .insert(owners)
      .values({ name: input.name, plan: input.plan, outletLimit: input.outletLimit })
      .returning();
    const [ownerUser] = await tx
      .insert(users)
      .values({ email: input.ownerEmail, name: input.ownerName, passwordHash, role: 'owner', ownerId: owner.id })
      .returning();
    let outletId: string | null = null;
    if (input.firstOutlet) {
      const [o] = await tx
        .insert(outlets)
        .values({ ownerId: owner.id, name: input.firstOutlet.name, code: input.firstOutlet.code.toUpperCase() })
        .returning();
      await tx.insert(outletSettings).values({ outletId: o.id });
      outletId = o.id;
    }
    await audit(tx, ctx, {
      category: 'Platform',
      action: 'Owner created',
      entityType: 'owner',
      entityId: owner.id,
      ownerId: owner.id,
      after: { name: owner.name, plan: owner.plan, outletLimit: owner.outletLimit },
    });
    return { owner, ownerUser, outletId };
  });
}

export async function listOwners(db: DB, ctx: Ctx) {
  requirePerm(ctx, 'platform.owners');
  const rows = await db.select().from(owners).orderBy(owners.createdAt);
  const outletCounts = await db
    .select({ ownerId: outlets.ownerId, n: sql<number>`count(*)::int` })
    .from(outlets)
    .where(ne(outlets.status, 'closed'))
    .groupBy(outlets.ownerId);
  const staffCounts = await db
    .select({ ownerId: users.ownerId, n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(ne(users.role, 'owner'), eq(users.status, 'active')))
    .groupBy(users.ownerId);
  return rows.map((o) => ({
    ...o,
    outletCount: outletCounts.find((c) => c.ownerId === o.id)?.n ?? 0,
    staffCount: staffCounts.find((c) => c.ownerId === o.id)?.n ?? 0,
  }));
}

const UpdateOwner = z.object({
  plan: z.enum(['trial', 'standard', 'pro']).optional(),
  outletLimit: z.number().int().min(1).max(50).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  reason: z.string().trim().optional(),
});

/** Changes plan, outlet limit or status. Suspending an owner signs everyone in that club out. */
export async function updateOwner(db: DB, ctx: Ctx, ownerId: string, raw: z.input<typeof UpdateOwner>) {
  requirePerm(ctx, 'platform.owners');
  const input = UpdateOwner.parse(raw);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(owners).where(eq(owners.id, ownerId)).for('update');
    if (!before) throw new AppError('not_found', 'Owner not found.');
    if (input.outletLimit !== undefined) {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(outlets)
        .where(and(eq(outlets.ownerId, ownerId), ne(outlets.status, 'closed')));
      if (input.outletLimit < n) {
        throw new AppError('invalid', `This owner already runs ${n} outlets. Close one before lowering the limit.`);
      }
    }
    if (input.status === 'suspended' && !input.reason) throw new AppError('invalid', 'Give a reason for suspending an owner.');
    const patch = {
      plan: input.plan ?? before.plan,
      outletLimit: input.outletLimit ?? before.outletLimit,
      status: input.status ?? before.status,
    };
    if (patch.plan === before.plan && patch.outletLimit === before.outletLimit && patch.status === before.status) return before;
    const [after] = await tx.update(owners).set(patch).where(eq(owners.id, ownerId)).returning();
    if (input.status === 'suspended') {
      const ids = (await tx.select({ id: users.id }).from(users).where(eq(users.ownerId, ownerId))).map((u) => u.id);
      if (ids.length) await tx.delete(authSessions).where(inArray(authSessions.userId, ids));
    }
    await audit(tx, ctx, {
      category: 'Platform',
      action: input.status ? `Owner ${input.status}` : 'Owner plan or limit changed',
      entityType: 'owner',
      entityId: ownerId,
      ownerId,
      before: { plan: before.plan, outletLimit: before.outletLimit, status: before.status },
      after: { plan: after.plan, outletLimit: after.outletLimit, status: after.status },
      reason: input.reason,
    });
    return after;
  });
}

export async function platformStats(db: DB, ctx: Ctx) {
  requirePerm(ctx, 'platform.owners');
  const [o] = await db.select({ n: sql<number>`count(*)::int` }).from(owners);
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(owners).where(eq(owners.status, 'active'));
  const [ou] = await db.select({ n: sql<number>`count(*)::int` }).from(outlets).where(eq(outlets.status, 'active'));
  const [s] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(ne(users.role, 'superadmin'), eq(users.status, 'active')));
  return { owners: o.n, activeOwners: a.n, outlets: ou.n, users: s.n };
}
