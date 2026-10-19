import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { STAFF_ROLES, requirePerm, requireTenant, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import { assertStrongPassword, hashPassword } from './auth';
import type { Q } from './db-types';

const { users, userOutlets, outlets, authSessions } = schema;

async function assertOwnOutlets(q: Q, ctx: Ctx, outletIds: string[]) {
  if (!outletIds.length) throw new AppError('invalid', 'Assign at least one outlet.');
  const ownerId = requireTenant(ctx);
  const rows = await q.select({ id: outlets.id }).from(outlets).where(and(eq(outlets.ownerId, ownerId), inArray(outlets.id, outletIds)));
  if (rows.length !== new Set(outletIds).size) throw new AppError('forbidden', 'One of those outlets is not yours.');
}

const CreateStaff = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(STAFF_ROLES),
  password: z.string(),
  outletIds: z.array(z.string().uuid()).min(1),
});

export async function createStaff(db: DB, ctx: Ctx, raw: z.input<typeof CreateStaff>) {
  requirePerm(ctx, 'staff.manage');
  const ownerId = requireTenant(ctx);
  const input = CreateStaff.parse(raw);
  assertStrongPassword(input.password);
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    await assertOwnOutlets(tx, ctx, input.outletIds);
    const [dup] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    if (dup) throw new AppError('conflict', 'That email is already in use.');
    const [u] = await tx
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash, role: input.role, ownerId })
      .returning();
    await tx.insert(userOutlets).values([...new Set(input.outletIds)].map((outletId) => ({ userId: u.id, outletId })));
    await audit(tx, ctx, {
      category: 'Staff',
      action: 'Staff account created',
      entityType: 'user',
      entityId: u.id,
      after: { name: u.name, role: u.role, outletIds: input.outletIds },
    });
    return u;
  });
}

export async function listStaff(db: DB, ctx: Ctx) {
  requirePerm(ctx, 'staff.manage');
  const ownerId = requireTenant(ctx);
  const rows = await db.select().from(users).where(eq(users.ownerId, ownerId)).orderBy(users.createdAt);
  const links = rows.length
    ? await db.select().from(userOutlets).where(inArray(userOutlets.userId, rows.map((r) => r.id)))
    : [];
  return rows.map(({ passwordHash: _hash, ...u }) => ({
    ...u,
    outletIds: links.filter((l) => l.userId === u.id).map((l) => l.outletId),
  }));
}

const UpdateStaff = z.object({
  name: z.string().trim().min(2).optional(),
  role: z.enum(STAFF_ROLES).optional(),
  outletIds: z.array(z.string().uuid()).min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export async function updateStaff(db: DB, ctx: Ctx, userId: string, raw: z.input<typeof UpdateStaff>) {
  requirePerm(ctx, 'staff.manage');
  const ownerId = requireTenant(ctx);
  const input = UpdateStaff.parse(raw);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.ownerId, ownerId)));
    if (!before) throw new AppError('not_found', 'Staff member not found.');
    if (before.role === 'owner') throw new AppError('forbidden', 'Owner accounts are managed by DepFlx.');
    const beforeOutlets = (await tx.select().from(userOutlets).where(eq(userOutlets.userId, userId))).map((l) => l.outletId);
    if (input.outletIds) {
      await assertOwnOutlets(tx, ctx, input.outletIds);
      await tx.delete(userOutlets).where(eq(userOutlets.userId, userId));
      await tx.insert(userOutlets).values([...new Set(input.outletIds)].map((outletId) => ({ userId, outletId })));
    }
    const [after] = await tx
      .update(users)
      .set({ name: input.name ?? before.name, role: input.role ?? before.role, status: input.status ?? before.status })
      .where(eq(users.id, userId))
      .returning();
    // A disabled or re-roled account loses its sessions so the change bites immediately.
    if (input.status === 'disabled' || (input.role && input.role !== before.role)) {
      await tx.delete(authSessions).where(eq(authSessions.userId, userId));
    }
    await audit(tx, ctx, {
      category: 'Staff',
      action: input.role && input.role !== before.role ? 'Staff role changed' : input.status ? `Staff ${input.status}` : 'Staff updated',
      entityType: 'user',
      entityId: userId,
      before: { name: before.name, role: before.role, status: before.status, outletIds: beforeOutlets },
      after: { name: after.name, role: after.role, status: after.status, outletIds: input.outletIds ?? beforeOutlets },
    });
    const { passwordHash: _hash, ...safe } = after;
    return safe;
  });
}

export async function resetStaffPassword(db: DB, ctx: Ctx, userId: string, password: string) {
  requirePerm(ctx, 'staff.manage');
  const ownerId = requireTenant(ctx);
  assertStrongPassword(password);
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.ownerId, ownerId)));
    if (!u || u.role === 'owner') throw new AppError('not_found', 'Staff member not found.');
    await tx.update(users).set({ passwordHash: hash }).where(eq(users.id, userId));
    await tx.delete(authSessions).where(eq(authSessions.userId, userId));
    await audit(tx, ctx, { category: 'Staff', action: 'Staff password reset', entityType: 'user', entityId: userId });
  });
}
