import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { login } from '@/server/auth';
import { bootstrap, DEMO, seedDemo } from '@/server/bootstrap';
import { kdsBoard } from '@/server/food';
import { ownerRollup, floorOverview } from '@/server/reports';
import { newDb } from './helpers';

afterEach(() => {
  delete process.env.DEMO_SEED;
  delete process.env.SUPERADMIN_EMAIL;
  delete process.env.SUPERADMIN_PASSWORD;
});

describe('bootstrap', () => {
  it('creates a superadmin from the environment once, and does not duplicate it', async () => {
    const db = await newDb();
    process.env.SUPERADMIN_EMAIL = 'Boss@Depflx.test';
    process.env.SUPERADMIN_PASSWORD = 'a-long-password';
    await bootstrap(db);
    await bootstrap(db);
    const rows = await db.select().from(schema.users).where(eq(schema.users.role, 'superadmin'));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('boss@depflx.test');
    expect((await login(db, { email: 'boss@depflx.test', password: 'a-long-password' })).ctx.role).toBe('superadmin');
  });

  it('creates nothing when no credentials are configured and demo mode is off', async () => {
    const db = await newDb();
    await bootstrap(db);
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });

  it('loads a demo club: two outlets, staff of every role, live tables, orders, and a kitchen board', async () => {
    const db = await newDb();
    process.env.DEMO_SEED = '1';
    await bootstrap(db);
    await seedDemo(db);
    expect(await db.select().from(schema.owners)).toHaveLength(1);
    const owner = (await login(db, { email: DEMO.owner.email, password: DEMO.owner.password })).ctx;
    expect(owner.outletIds).toHaveLength(2);
    const roll = await ownerRollup(db, owner);
    expect(roll.perOutlet).toHaveLength(2);
    expect(roll.totals.walletLiability).toBeGreaterThan(0);
    const floor = await floorOverview(db, owner);
    expect(floor.filter((t) => t.inPlay).length).toBe(3);
    expect(floor.find((t) => t.name === 'Table 2' && t.seats.length === 8)).toBeDefined();
    const kds = (await login(db, { email: DEMO.staff.kds, password: DEMO.staff.password })).ctx;
    expect((await kdsBoard(db, kds, kds.outletIds[0])).length).toBeGreaterThanOrEqual(2);
    for (const e of [DEMO.staff.cashier, DEMO.staff.dealer, DEMO.staff.waiter]) {
      expect((await login(db, { email: e, password: DEMO.staff.password })).ctx.outletIds.length).toBeGreaterThan(0);
    }
  });
});
