import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { buildCtx, login } from '@/server/auth';
import { listAudit } from '@/server/audit';
import { createOutlet, getSettings, listOutlets, updateOutlet, updateSettings } from '@/server/outlets';
import { createStaff, listStaff, resetStaffPassword, updateStaff } from '@/server/staff';
import { errorOf, PASSWORD, world, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
});

describe('owner: outlets and the plan limit', () => {
  it('lists only the owner’s own outlets', async () => {
    const mine = await listOutlets(w.db, w.ownerA);
    expect(mine.map((o) => o.id).sort()).toEqual([w.a1, w.a2].sort());
    expect((await listOutlets(w.db, w.ownerB)).map((o) => o.id)).toEqual([w.b1]);
  });

  it('refuses a new outlet once the limit is reached, with a clear message', async () => {
    const err = await errorOf(createOutlet(w.db, w.ownerB, { name: 'Nashik', code: 'NSK' }));
    expect(err?.code).toBe('conflict');
    expect(err?.message).toContain('plan allows 1 outlet');
  });

  it('allows outlets up to the limit and rejects duplicate codes', async () => {
    const third = await createOutlet(w.db, w.ownerA, { name: 'Thane', code: 'thn' });
    expect(third.code).toBe('THN');
    const err = await errorOf(createOutlet(w.db, await buildCtx(w.db, w.ownerA.userId), { name: 'Again', code: 'THN' }));
    expect(err?.code).toBe('conflict');
  });

  it('two simultaneous requests cannot both slip under the limit', async () => {
    const results = await Promise.allSettled([
      createOutlet(w.db, w.ownerB, { name: 'Race One', code: 'RC1' }),
      createOutlet(w.db, w.ownerB, { name: 'Race Two', code: 'RC2' }),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect((await w.db.select().from(schema.outlets).where(eq(schema.outlets.ownerId, w.B.owner.id))).length).toBe(1);
  });

  it('staff cannot create or rename outlets', async () => {
    expect((await errorOf(createOutlet(w.db, w.staffA.cashier, { name: 'Sneaky', code: 'SNK' })))?.code).toBe('forbidden');
    expect((await errorOf(updateOutlet(w.db, w.staffA.cashier, w.a1, { name: 'Hacked' })))?.code).toBe('forbidden');
  });

  it('an owner cannot rename another owner’s outlet', async () => {
    expect((await errorOf(updateOutlet(w.db, w.ownerA, w.b1, { name: 'Mine now' })))?.code).toBe('forbidden');
  });

  it('closing an outlet is blocked while a shift is unapproved', async () => {
    const ctx = await buildCtx(w.db, w.ownerA.userId);
    await w.db.insert(schema.shifts).values({ outletId: w.a2, cashierId: w.staffA.cashier2.userId, openingCash: 0 });
    const err = await errorOf(updateOutlet(w.db, ctx, w.a2, { status: 'closed' }));
    expect(err?.code).toBe('conflict');
    await w.db.delete(schema.shifts).where(eq(schema.shifts.outletId, w.a2));
    expect((await updateOutlet(w.db, ctx, w.a2, { status: 'closed' })).status).toBe('closed');
    await updateOutlet(w.db, ctx, w.a2, { status: 'active' });
  });
});

describe('owner: outlet settings', () => {
  it('reads defaults and changes guest food policy and fees', async () => {
    const before = await getSettings(w.db, w.ownerA, w.a1);
    expect(before.guestMode).toBe('free');
    const after = await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'chargeable', guestPayer: 'separate', issueFee: 15000 });
    expect(after.guestMode).toBe('chargeable');
    expect(after.guestPayer).toBe('separate');
    expect(after.issueFee).toBe(15000);
    expect(after.replacementFee).toBe(before.replacementFee);
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'free', guestPayer: 'player', issueFee: 10000 });
  });

  it('keeps settings per outlet', async () => {
    await updateSettings(w.db, w.ownerA, w.a2, { replacementFee: 33300 });
    expect((await getSettings(w.db, w.ownerA, w.a1)).replacementFee).not.toBe(33300);
    expect((await getSettings(w.db, w.ownerA, w.a2)).replacementFee).toBe(33300);
  });

  it('merges tier fees instead of replacing the set', async () => {
    const s = await updateSettings(w.db, w.ownerA, w.a1, { tierFees: { Gold: 300000 } });
    expect(s.tierFees.Gold).toBe(300000);
    expect(s.tierFees.Bronze).toBe(50000);
  });

  it('refuses to switch cash-out on', async () => {
    const err = await errorOf(updateSettings(w.db, w.ownerA, w.a1, { cashoutEnabled: true }));
    expect(err?.code).toBe('invalid');
    expect((await getSettings(w.db, w.ownerA, w.a1)).cashoutEnabled).toBe(false);
  });

  it('rejects invalid values', async () => {
    expect(await errorOf(updateSettings(w.db, w.ownerA, w.a1, { issueFee: -5 }))).toBeDefined();
    expect(await errorOf(updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'sometimes' as never }))).toBeDefined();
  });

  it('staff cannot change settings and owners cannot touch another owner’s outlet', async () => {
    expect((await errorOf(updateSettings(w.db, w.staffA.cashier, w.a1, { issueFee: 1 })))?.code).toBe('forbidden');
    expect((await errorOf(updateSettings(w.db, w.ownerA, w.b1, { issueFee: 1 })))?.code).toBe('forbidden');
    expect((await errorOf(getSettings(w.db, w.ownerA, w.b1)))?.code).toBe('forbidden');
  });

  it('records the change in the owner audit trail with before and after', async () => {
    const trail = await listAudit(w.db, w.ownerA, { category: 'Settings' });
    expect(trail.length).toBeGreaterThan(0);
    expect(trail[0].before).toBeTruthy();
    expect(trail[0].after).toBeTruthy();
  });
});

describe('owner: staff', () => {
  it('creates staff with a role and outlets, and they can sign in', async () => {
    const u = await createStaff(w.db, w.ownerA, {
      name: 'New Cashier', email: 'NEW@club.test', role: 'cashier', password: PASSWORD, outletIds: [w.a1, w.a2],
    });
    expect(u.email).toBe('new@club.test');
    const { ctx } = await login(w.db, { email: 'new@club.test', password: PASSWORD });
    expect(ctx.role).toBe('cashier');
    expect(ctx.outletIds.sort()).toEqual([w.a1, w.a2].sort());
  });

  it('rejects another owner’s outlets, empty outlet lists, duplicate emails, and the owner or superadmin roles', async () => {
    const base = { name: 'Bad Hire', password: PASSWORD, role: 'dealer' as const };
    expect((await errorOf(createStaff(w.db, w.ownerA, { ...base, email: 'x1@club.test', outletIds: [w.b1] })))?.code).toBe('forbidden');
    expect(await errorOf(createStaff(w.db, w.ownerA, { ...base, email: 'x2@club.test', outletIds: [] }))).toBeDefined();
    expect((await errorOf(createStaff(w.db, w.ownerA, { ...base, email: 'new@club.test', outletIds: [w.a1] })))?.code).toBe('conflict');
    expect(await errorOf(createStaff(w.db, w.ownerA, { ...base, role: 'owner' as never, email: 'x3@club.test', outletIds: [w.a1] }))).toBeDefined();
    expect(await errorOf(createStaff(w.db, w.ownerA, { ...base, role: 'superadmin' as never, email: 'x4@club.test', outletIds: [w.a1] }))).toBeDefined();
  });

  it('lists only this owner’s staff and never exposes password hashes', async () => {
    const list = await listStaff(w.db, w.ownerA);
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(list.every((s) => !('passwordHash' in s))).toBe(true);
    const b = await listStaff(w.db, w.ownerB);
    expect(b.some((s) => s.email.endsWith('@club.test') && s.email.includes('.a1'))).toBe(false);
  });

  it('changing a role or disabling a person ends their live sessions immediately', async () => {
    const { ctx, token } = await login(w.db, { email: 'dealer.a1@club.test', password: PASSWORD });
    const { loadCtx } = await import('@/server/auth');
    expect(await loadCtx(w.db, token)).not.toBeNull();
    await updateStaff(w.db, w.ownerA, ctx.userId, { role: 'waiter' });
    expect(await loadCtx(w.db, token)).toBeNull();
    expect((await login(w.db, { email: 'dealer.a1@club.test', password: PASSWORD })).ctx.role).toBe('waiter');
    await updateStaff(w.db, w.ownerA, ctx.userId, { role: 'dealer' });
    await updateStaff(w.db, w.ownerA, ctx.userId, { status: 'disabled' });
    expect((await errorOf(login(w.db, { email: 'dealer.a1@club.test', password: PASSWORD })))?.code).toBe('unauthenticated');
    await updateStaff(w.db, w.ownerA, ctx.userId, { status: 'active' });
  });

  it('reassigns outlets', async () => {
    const list = await listStaff(w.db, w.ownerA);
    const waiter = list.find((s) => s.email === 'waiter.a1@club.test')!;
    await updateStaff(w.db, w.ownerA, waiter.id, { outletIds: [w.a2] });
    expect((await buildCtx(w.db, waiter.id)).outletIds).toEqual([w.a2]);
    await updateStaff(w.db, w.ownerA, waiter.id, { outletIds: [w.a1] });
  });

  it('cannot manage staff of another owner or any owner account', async () => {
    const bobStaff = (await listStaff(w.db, w.ownerB)).find((s) => s.role === 'cashier')!;
    expect((await errorOf(updateStaff(w.db, w.ownerA, bobStaff.id, { status: 'disabled' })))?.code).toBe('not_found');
    expect((await errorOf(updateStaff(w.db, w.ownerA, w.ownerA.userId, { status: 'disabled' })))?.code).toBe('forbidden');
    expect((await errorOf(resetStaffPassword(w.db, w.ownerA, bobStaff.id, 'password999')))?.code).toBe('not_found');
  });

  it('resets a password and signs the person out', async () => {
    const { ctx, token } = await login(w.db, { email: 'kds.a1@club.test', password: PASSWORD });
    await resetStaffPassword(w.db, w.ownerA, ctx.userId, 'brandnewpass1');
    const { loadCtx } = await import('@/server/auth');
    expect(await loadCtx(w.db, token)).toBeNull();
    expect((await login(w.db, { email: 'kds.a1@club.test', password: 'brandnewpass1' })).ctx.role).toBe('kds');
  });

  it('staff cannot manage staff', async () => {
    expect((await errorOf(listStaff(w.db, w.staffA.cashier)))?.code).toBe('forbidden');
    expect((await errorOf(createStaff(w.db, w.staffA.cashier, { name: 'Sneak', email: 's@s.test', role: 'cashier', password: PASSWORD, outletIds: [w.a1] })))?.code).toBe('forbidden');
  });

  it('writes role changes to the audit trail', async () => {
    const trail = await listAudit(w.db, w.ownerA, { category: 'Staff' });
    expect(trail.some((t) => t.action === 'Staff role changed')).toBe(true);
    expect(trail.some((t) => t.action === 'Staff account created')).toBe(true);
  });
});
