import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { requirePerm, type Ctx, type Role } from '@/lib/permissions';
import { audit } from './audit';

const { users, owners, outlets, userOutlets, authSessions, loginAttempts } = schema;

const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const WINDOW_MS = 15 * 60 * 1000;
const cost = () => Number(process.env.BCRYPT_COST ?? 10);

export const hashPassword = (pw: string) => bcrypt.hash(pw, cost());
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function assertStrongPassword(pw: string) {
  if (pw.length < 8) throw new AppError('invalid', 'Password must be at least 8 characters.');
}

/** Builds the permission context for a user: which tenant and which outlets they may touch. */
export async function buildCtx(db: DB, userId: string, impersonatorId: string | null = null): Promise<Ctx> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.status !== 'active') throw new AppError('unauthenticated', 'Sign in again.');
  let outletIds: string[] = [];
  if (u.role === 'owner') {
    outletIds = (await db.select({ id: outlets.id }).from(outlets).where(eq(outlets.ownerId, u.ownerId!))).map((o) => o.id);
  } else if (u.role !== 'superadmin') {
    outletIds = (await db.select({ id: userOutlets.outletId }).from(userOutlets).where(eq(userOutlets.userId, u.id))).map((o) => o.id);
  }
  return { userId: u.id, name: u.name, role: u.role as Role, ownerId: u.ownerId, outletIds, impersonatorId };
}

async function startSession(db: DB, userId: string, impersonatorId: string | null = null) {
  const token = randomBytes(32).toString('hex');
  await db.insert(authSessions).values({
    tokenHash: sha(token),
    userId,
    impersonatorId,
    expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000),
  });
  return token;
}

export async function login(db: DB, input: { email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const since = new Date(Date.now() - WINDOW_MS);
  const recent = await db
    .select()
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, email), gt(loginAttempts.at, since)));
  // Count only failures since the last success so a good sign-in resets the throttle.
  let failures = 0;
  for (const a of recent.sort((x, y) => x.at.getTime() - y.at.getTime())) failures = a.ok ? 0 : failures + 1;
  if (failures >= MAX_FAILED) throw new AppError('throttled', 'Too many failed sign-ins. Try again in 15 minutes.');

  const [u] = await db.select().from(users).where(eq(users.email, email));
  const ok = !!u && u.status === 'active' && (await verifyPassword(input.password, u.passwordHash));
  await db.insert(loginAttempts).values({ email, ok });
  if (!ok) throw new AppError('unauthenticated', 'Email or password is incorrect.');

  if (u.ownerId) {
    const [o] = await db.select().from(owners).where(eq(owners.id, u.ownerId));
    if (o.status !== 'active') throw new AppError('forbidden', 'This account is suspended. Contact DepFlx support.');
  }
  const token = await startSession(db, u.id);
  const ctx = await buildCtx(db, u.id);
  await audit(db, ctx, { category: 'Auth', action: 'Signed in' });
  return { token, ctx };
}

export async function logout(db: DB, token: string) {
  await db.delete(authSessions).where(eq(authSessions.tokenHash, sha(token)));
}

/** Resolves a cookie token to a permission context, or null when missing, expired or revoked. */
export async function loadCtx(db: DB, token: string | undefined | null): Promise<Ctx | null> {
  if (!token) return null;
  const [s] = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, sha(token)), gt(authSessions.expiresAt, new Date())));
  if (!s) return null;
  try {
    const ctx = await buildCtx(db, s.userId, s.impersonatorId);
    if (ctx.ownerId) {
      const [o] = await db.select().from(owners).where(eq(owners.id, ctx.ownerId));
      if (o.status !== 'active') return null;
    }
    return ctx;
  } catch {
    return null;
  }
}

/** Superadmin opens an owner's console for support. Recorded on the platform and owner trails. */
export async function impersonate(db: DB, ctx: Ctx, ownerId: string) {
  requirePerm(ctx, 'platform.impersonate');
  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.ownerId, ownerId), eq(users.role, 'owner'), eq(users.status, 'active')))
    .limit(1);
  if (!target) throw new AppError('not_found', 'That owner has no active owner account.');
  const token = await startSession(db, target.id, ctx.userId);
  await audit(db, ctx, {
    category: 'Platform',
    action: 'Impersonation started',
    entityType: 'owner',
    entityId: ownerId,
    ownerId,
  });
  return { token, ctx: await buildCtx(db, target.id, ctx.userId) };
}

export async function changePassword(db: DB, ctx: Ctx, input: { current: string; next: string }) {
  assertStrongPassword(input.next);
  const [u] = await db.select().from(users).where(eq(users.id, ctx.userId));
  if (!(await verifyPassword(input.current, u.passwordHash))) throw new AppError('invalid', 'Current password is incorrect.');
  await db.update(users).set({ passwordHash: await hashPassword(input.next) }).where(eq(users.id, u.id));
  await db.delete(authSessions).where(eq(authSessions.userId, u.id));
  await audit(db, ctx, { category: 'Auth', action: 'Password changed' });
}
