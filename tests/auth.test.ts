import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { changePassword, impersonate, loadCtx, login, logout } from '@/server/auth';
import { listPlatformAudit } from '@/server/audit';
import { updateOwner } from '@/server/superadmin';
import { errorOf, PASSWORD, world, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
});

describe('login and sessions', () => {
  it('signs in with the right password and resolves the session to a context', async () => {
    const { token, ctx } = await login(w.db, { email: 'priya@a.test', password: PASSWORD });
    expect(ctx.role).toBe('owner');
    expect(ctx.outletIds.sort()).toEqual([w.a1, w.a2].sort());
    const loaded = await loadCtx(w.db, token);
    expect(loaded?.userId).toBe(ctx.userId);
  });

  it('is case-insensitive on email and rejects a wrong password with one generic message', async () => {
    expect((await login(w.db, { email: 'PRIYA@A.TEST', password: PASSWORD })).ctx.role).toBe('owner');
    const bad = await errorOf(login(w.db, { email: 'priya@a.test', password: 'nope-nope' }));
    const unknown = await errorOf(login(w.db, { email: 'ghost@a.test', password: 'nope-nope' }));
    expect(bad?.code).toBe('unauthenticated');
    expect(bad?.message).toBe(unknown?.message);
  });

  it('returns null for missing, unknown or logged-out tokens', async () => {
    expect(await loadCtx(w.db, undefined)).toBeNull();
    expect(await loadCtx(w.db, 'deadbeef')).toBeNull();
    const { token } = await login(w.db, { email: 'priya@a.test', password: PASSWORD });
    await logout(w.db, token);
    expect(await loadCtx(w.db, token)).toBeNull();
  });

  it('expires sessions', async () => {
    const { token } = await login(w.db, { email: 'priya@a.test', password: PASSWORD });
    await w.db.update(schema.authSessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await loadCtx(w.db, token)).toBeNull();
  });

  it('throttles after five failures and a good sign-in is blocked until the window passes', async () => {
    const email = 'ravi.throttle@club.test';
    await w.db.insert(schema.users).values({
      email, name: 'T', passwordHash: 'x', role: 'cashier', ownerId: w.A.owner.id,
    });
    for (let i = 0; i < 5; i++) await errorOf(login(w.db, { email, password: 'wrong-pass' }));
    const blocked = await errorOf(login(w.db, { email, password: PASSWORD }));
    expect(blocked?.code).toBe('throttled');
  });

  it('refuses disabled users and suspended owners, and kills live sessions when an owner is suspended', async () => {
    const { token } = await login(w.db, { email: 'bob@b.test', password: PASSWORD });
    await updateOwner(w.db, w.sa, w.B.owner.id, { status: 'suspended', reason: 'Unpaid invoice' });
    expect(await loadCtx(w.db, token)).toBeNull();
    const err = await errorOf(login(w.db, { email: 'bob@b.test', password: PASSWORD }));
    expect(err?.code).toBe('forbidden');
    await updateOwner(w.db, w.sa, w.B.owner.id, { status: 'active' });
    expect((await login(w.db, { email: 'bob@b.test', password: PASSWORD })).ctx.role).toBe('owner');
  });

  it('changes a password, revokes sessions and rejects weak or wrong-current passwords', async () => {
    const { token, ctx } = await login(w.db, { email: 'waiter.a1@club.test', password: PASSWORD });
    expect((await errorOf(changePassword(w.db, ctx, { current: 'wrong-pass', next: 'newpassword1' })))?.code).toBe('invalid');
    expect((await errorOf(changePassword(w.db, ctx, { current: PASSWORD, next: 'short' })))?.code).toBe('invalid');
    await changePassword(w.db, ctx, { current: PASSWORD, next: 'newpassword1' });
    expect(await loadCtx(w.db, token)).toBeNull();
    expect((await login(w.db, { email: 'waiter.a1@club.test', password: 'newpassword1' })).ctx.role).toBe('waiter');
  });
});

describe('impersonation', () => {
  it('lets a superadmin act as an owner and records both sides', async () => {
    const { token, ctx } = await impersonate(w.db, w.sa, w.A.owner.id);
    expect(ctx.role).toBe('owner');
    expect(ctx.impersonatorId).toBe(w.sa.userId);
    const loaded = await loadCtx(w.db, token);
    expect(loaded?.impersonatorId).toBe(w.sa.userId);
    const trail = await listPlatformAudit(w.db, w.sa, { ownerId: w.A.owner.id });
    expect(trail.some((t) => t.action === 'Impersonation started' && t.actorId === w.sa.userId)).toBe(true);
  });

  it('is limited to superadmins', async () => {
    const err = await errorOf(impersonate(w.db, w.ownerA, w.B.owner.id));
    expect(err?.code).toBe('forbidden');
  });

  it('actions taken while impersonating carry the impersonator on the audit row', async () => {
    const { ctx } = await impersonate(w.db, w.sa, w.A.owner.id);
    const { createOutlet } = await import('@/server/outlets');
    await createOutlet(w.db, ctx, { name: 'Powai', code: 'POW' });
    const rows = await w.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'Outlet created'));
    const row = rows.find((r) => (r.after as { code: string }).code === 'POW')!;
    expect(row.impersonatorId).toBe(w.sa.userId);
  });
});
