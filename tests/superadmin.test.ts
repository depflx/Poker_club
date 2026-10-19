import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { listPlatformAudit } from '@/server/audit';
import { createOutlet } from '@/server/outlets';
import { createOwner, listOwners, platformStats, updateOwner } from '@/server/superadmin';
import { errorOf, PASSWORD, world, type World } from './helpers';

let w: World;
beforeAll(async () => {
  w = await world();
});

describe('superadmin: owners', () => {
  it('onboards an owner with a login, an outlet and default settings', async () => {
    const r = await createOwner(w.db, w.sa, {
      name: 'Club C', ownerName: 'Cara', ownerEmail: 'Cara@C.test', password: PASSWORD,
      firstOutlet: { name: 'Delhi', code: 'del' },
    });
    expect(r.ownerUser.email).toBe('cara@c.test');
    expect(r.owner.plan).toBe('trial');
    expect(r.owner.outletLimit).toBe(1);
    const [s] = await w.db.select().from(schema.outletSettings).where(eq(schema.outletSettings.outletId, r.outletId!));
    expect(s.guestMode).toBe('free');
    expect(s.cashoutEnabled).toBe(false);
    const [o] = await w.db.select().from(schema.outlets).where(eq(schema.outlets.id, r.outletId!));
    expect(o.code).toBe('DEL');
  });

  it('rejects duplicate emails, weak passwords and bad input, leaving nothing half-created', async () => {
    const before = (await listOwners(w.db, w.sa)).length;
    expect((await errorOf(createOwner(w.db, w.sa, { name: 'Dup', ownerName: 'Dup', ownerEmail: 'priya@a.test', password: PASSWORD })))?.code).toBe('conflict');
    expect((await errorOf(createOwner(w.db, w.sa, { name: 'Weak', ownerName: 'Weak', ownerEmail: 'w@w.test', password: 'short' })))?.code).toBe('invalid');
    expect(await errorOf(createOwner(w.db, w.sa, { name: 'X', ownerName: 'Xy', ownerEmail: 'not-an-email', password: PASSWORD }))).toBeDefined();
    expect((await listOwners(w.db, w.sa)).length).toBe(before);
  });

  it('lists owners with outlet and staff counts', async () => {
    const owners = await listOwners(w.db, w.sa);
    const a = owners.find((o) => o.id === w.A.owner.id)!;
    expect(a.outletCount).toBe(2);
    expect(a.staffCount).toBe(5);
    expect(owners.find((o) => o.id === w.B.owner.id)!.outletCount).toBe(1);
  });

  it('changes plan and outlet limit but never below the outlets already open', async () => {
    const up = await updateOwner(w.db, w.sa, w.B.owner.id, { plan: 'pro', outletLimit: 4 });
    expect(up.plan).toBe('pro');
    expect(up.outletLimit).toBe(4);
    const err = await errorOf(updateOwner(w.db, w.sa, w.A.owner.id, { outletLimit: 1 }));
    expect(err?.code).toBe('invalid');
    expect(err?.message).toContain('2 outlets');
    await updateOwner(w.db, w.sa, w.B.owner.id, { outletLimit: 1 });
  });

  it('requires a reason to suspend, and unknown owners are not found', async () => {
    expect((await errorOf(updateOwner(w.db, w.sa, w.B.owner.id, { status: 'suspended' })))?.code).toBe('invalid');
    expect((await errorOf(updateOwner(w.db, w.sa, '00000000-0000-4000-8000-000000000000', { plan: 'pro' })))?.code).toBe('not_found');
  });

  it('writes before and after to the platform audit log', async () => {
    await updateOwner(w.db, w.sa, w.A.owner.id, { plan: 'standard' });
    const trail = await listPlatformAudit(w.db, w.sa, { ownerId: w.A.owner.id, category: 'Platform' });
    const row = trail.find((t) => t.action === 'Owner plan or limit changed')!;
    expect((row.before as { plan: string }).plan).toBe('pro');
    expect((row.after as { plan: string }).plan).toBe('standard');
    await updateOwner(w.db, w.sa, w.A.owner.id, { plan: 'pro' });
  });

  it('a save that changes nothing leaves no audit entry', async () => {
    const before = (await listPlatformAudit(w.db, w.sa, { ownerId: w.A.owner.id })).length;
    const o = await updateOwner(w.db, w.sa, w.A.owner.id, { plan: 'pro', outletLimit: 3 });
    expect(o.plan).toBe('pro');
    expect((await listPlatformAudit(w.db, w.sa, { ownerId: w.A.owner.id })).length).toBe(before);
  });

  it('reports platform totals', async () => {
    const s = await platformStats(w.db, w.sa);
    expect(s.owners).toBeGreaterThanOrEqual(3);
    expect(s.outlets).toBeGreaterThanOrEqual(4);
  });
});

describe('superadmin: boundaries', () => {
  it('owners and staff cannot use platform functions', async () => {
    for (const ctx of [w.ownerA, w.staffA.cashier]) {
      expect((await errorOf(listOwners(w.db, ctx)))?.code).toBe('forbidden');
      expect((await errorOf(updateOwner(w.db, ctx, w.B.owner.id, { plan: 'pro' })))?.code).toBe('forbidden');
      expect((await errorOf(listPlatformAudit(w.db, ctx)))?.code).toBe('forbidden');
    }
  });

  it('a superadmin has no tenant, so cannot create outlets or touch club data directly', async () => {
    expect((await errorOf(createOutlet(w.db, w.sa, { name: 'Nope', code: 'NO' })))?.code).toBe('forbidden');
  });
});
