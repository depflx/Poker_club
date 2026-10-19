import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { requirePerm, requireTenant, type Ctx } from '@/lib/permissions';
import type { Q } from './db-types';

export interface AuditInput {
  category:
    | 'Platform' | 'Auth' | 'Outlets' | 'Staff' | 'Settings' | 'Members' | 'Cards' | 'Wallet'
    | 'Shifts' | 'Chips' | 'Rounds' | 'Food';
  action: string;
  entityType?: string;
  entityId?: string;
  outletId?: string | null;
  ownerId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Writes one append-only audit row. Always call inside the same transaction as the change. */
export async function audit(q: Q, ctx: Pick<Ctx, 'userId' | 'role' | 'ownerId' | 'impersonatorId'>, e: AuditInput) {
  await q.insert(schema.auditLogs).values({
    ownerId: e.ownerId === undefined ? ctx.ownerId : e.ownerId,
    outletId: e.outletId ?? null,
    actorId: ctx.userId,
    actorRole: ctx.role,
    impersonatorId: ctx.impersonatorId,
    category: e.category,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    reason: e.reason ?? null,
  });
}

export interface AuditFilter {
  category?: string;
  q?: string;
  outletId?: string;
  limit?: number;
}

/** Owner view: this owner's trail, optionally narrowed to a category, outlet or search text. */
export async function listAudit(db: DB, ctx: Ctx, f: AuditFilter = {}) {
  requirePerm(ctx, 'audit.read');
  const a = schema.auditLogs;
  const conds = [eq(a.ownerId, requireTenant(ctx))];
  if (f.category) conds.push(eq(a.category, f.category));
  if (f.outletId) conds.push(eq(a.outletId, f.outletId));
  if (f.q) {
    const like = `%${f.q}%`;
    conds.push(or(ilike(a.action, like), ilike(a.entityId, like), ilike(a.reason, like))!);
  }
  return db.select().from(a).where(and(...conds)).orderBy(desc(a.createdAt)).limit(f.limit ?? 200);
}

/** Superadmin view: the whole platform trail. */
export async function listPlatformAudit(db: DB, ctx: Ctx, f: AuditFilter & { ownerId?: string } = {}) {
  requirePerm(ctx, 'platform.audit');
  const a = schema.auditLogs;
  const conds = [sql`true`];
  if (f.ownerId) conds.push(eq(a.ownerId, f.ownerId));
  if (f.category) conds.push(eq(a.category, f.category));
  return db.select().from(a).where(and(...conds)).orderBy(desc(a.createdAt)).limit(f.limit ?? 200);
}
