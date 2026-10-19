import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requireOutlet, requirePerm, requireTenant, type Ctx } from '@/lib/permissions';
import { audit } from './audit';

const { owners, outlets, outletSettings, pokerSessions, shifts } = schema;

const CreateOutlet = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().min(2).max(8).transform((s) => s.toUpperCase()),
});

/** Creates an outlet, refusing once the owner's plan limit is reached. */
export async function createOutlet(db: DB, ctx: Ctx, raw: z.input<typeof CreateOutlet>) {
  requirePerm(ctx, 'outlets.manage');
  const ownerId = requireTenant(ctx);
  const input = CreateOutlet.parse(raw);
  return db.transaction(async (tx) => {
    // Lock the owner row so two simultaneous requests cannot both slip under the limit.
    const [owner] = await tx.select().from(owners).where(eq(owners.id, ownerId)).for('update');
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outlets)
      .where(and(eq(outlets.ownerId, ownerId), ne(outlets.status, 'closed')));
    if (n >= owner.outletLimit) {
      throw new AppError('conflict', `Your plan allows ${owner.outletLimit} outlet${owner.outletLimit === 1 ? '' : 's'}. Contact DepFlx to add more.`);
    }
    const [dup] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(and(eq(outlets.ownerId, ownerId), eq(outlets.code, input.code)));
    if (dup) throw new AppError('conflict', 'An outlet with that code already exists.');
    const [outlet] = await tx.insert(outlets).values({ ownerId, name: input.name, code: input.code }).returning();
    await tx.insert(outletSettings).values({ outletId: outlet.id });
    await audit(tx, ctx, {
      category: 'Outlets',
      action: 'Outlet created',
      entityType: 'outlet',
      entityId: outlet.id,
      outletId: outlet.id,
      after: { name: outlet.name, code: outlet.code },
    });
    return outlet;
  });
}

export async function listOutlets(db: DB, ctx: Ctx) {
  requireTenant(ctx);
  if (!ctx.outletIds.length) return [];
  return db.select().from(outlets).where(inArray(outlets.id, ctx.outletIds)).orderBy(outlets.createdAt);
}

export async function updateOutlet(db: DB, ctx: Ctx, outletId: string, raw: { name?: string; status?: 'active' | 'closed' }) {
  requirePerm(ctx, 'outlets.manage');
  requireOutlet(ctx, outletId);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).for('update');
    if (raw.status === 'closed') {
      const [s] = await tx
        .select({ id: pokerSessions.id })
        .from(pokerSessions)
        .where(and(eq(pokerSessions.outletId, outletId), eq(pokerSessions.status, 'in_progress')))
        .limit(1);
      const [sh] = await tx
        .select({ id: shifts.id })
        .from(shifts)
        .where(and(eq(shifts.outletId, outletId), ne(shifts.status, 'approved')))
        .limit(1);
      if (s || sh) throw new AppError('conflict', 'Close open sessions and shifts before closing this outlet.');
    }
    const [after] = await tx
      .update(outlets)
      .set({ name: raw.name?.trim() || before.name, status: raw.status ?? before.status })
      .where(eq(outlets.id, outletId))
      .returning();
    await audit(tx, ctx, {
      category: 'Outlets',
      action: raw.status && raw.status !== before.status ? `Outlet ${raw.status}` : 'Outlet renamed',
      entityType: 'outlet',
      entityId: outletId,
      outletId,
      before: { name: before.name, status: before.status },
      after: { name: after.name, status: after.status },
    });
    return after;
  });
}

// ---------- settings ----------
const Settings = z.object({
  guestMode: z.enum(['free', 'chargeable']),
  guestPayer: z.enum(['player', 'separate']),
  issueFee: z.number().int().min(0),
  replacementFee: z.number().int().min(0),
  approvalThreshold: z.number().int().min(1),
  cashoutEnabled: z.boolean(),
  tierFees: z.record(z.enum(['Bronze', 'Silver', 'Gold', 'Platinum']), z.number().int().min(0)),
});
export type OutletSettings = z.infer<typeof Settings>;

export async function getSettings(db: DB, ctx: Ctx, outletId: string) {
  requireOutlet(ctx, outletId);
  const [s] = await db.select().from(outletSettings).where(eq(outletSettings.outletId, outletId));
  if (!s) throw new AppError('not_found', 'Outlet settings not found.');
  return s;
}

export type SettingsPatch = Partial<Omit<OutletSettings, 'tierFees'>> & { tierFees?: Partial<OutletSettings['tierFees']> };

export async function updateSettings(db: DB, ctx: Ctx, outletId: string, patch: SettingsPatch) {
  requirePerm(ctx, 'settings.manage');
  requireOutlet(ctx, outletId);
  if (patch.cashoutEnabled === true) {
    throw new AppError('invalid', 'Cash-out stays disabled until legal and compliance approval is recorded.');
  }
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(outletSettings).where(eq(outletSettings.outletId, outletId)).for('update');
    const merged = Settings.parse({ ...before, ...patch, tierFees: { ...before.tierFees, ...(patch.tierFees ?? {}) } });
    const [after] = await tx.update(outletSettings).set(merged).where(eq(outletSettings.outletId, outletId)).returning();
    await audit(tx, ctx, {
      category: 'Settings',
      action: 'Outlet settings changed',
      entityType: 'outlet_settings',
      entityId: outletId,
      outletId,
      before,
      after,
    });
    return after;
  });
}
