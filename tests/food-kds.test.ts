import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import { listAudit } from '@/server/audit';
import { addMenuItem, kdsBoard, listMenu, orderHistory, placeOrder, updateMenuItem, updateOrderStatus } from '@/server/food';
import { updateSettings } from '@/server/outlets';
import { createTable, openSession, seatPlayer } from '@/server/poker';
import { reverseEntry } from '@/server/wallet';
import { balanceOf } from '@/server/wallet';
import { rupees } from '@/lib/money';
import { errorOf, key, mkPlayer, world, type World } from './helpers';

let w: World;
let fries: string;
let biryani: string;
let sessionId: string;
beforeAll(async () => {
  w = await world();
  fries = (await addMenuItem(w.db, w.ownerA, { outletId: w.a1, name: 'Masala Fries', category: 'Snacks', guestPrice: rupees(150) })).id;
  biryani = (await addMenuItem(w.db, w.ownerA, { outletId: w.a1, name: 'Veg Biryani', category: 'Mains', guestPrice: rupees(280) })).id;
  const t = await createTable(w.db, w.ownerA, { outletId: w.a1, name: 'Food Table' });
  sessionId = (await openSession(w.db, w.staffA.dealer, t.id)).id;
});

const order = (ctx: typeof w.staffA.waiter, args: Partial<Parameters<typeof placeOrder>[2]> & { uid?: string; memberId?: string }) =>
  placeOrder(w.db, ctx, {
    outletId: w.a1, orderType: 'player', guestCount: 0, items: [{ menuItemId: fries, quantity: 2 }], idempotencyKey: key(), ...args,
  } as Parameters<typeof placeOrder>[2]);

describe('menu', () => {
  it('the owner manages the menu; waiters see only available items', async () => {
    const brownie = await addMenuItem(w.db, w.ownerA, { outletId: w.a1, name: 'Brownie', guestPrice: rupees(160), available: false });
    expect((await listMenu(w.db, w.ownerA, w.a1)).map((m) => m.name)).toContain('Brownie');
    expect((await listMenu(w.db, w.staffA.waiter, w.a1)).map((m) => m.name)).not.toContain('Brownie');
    await updateMenuItem(w.db, w.ownerA, brownie.id, { available: true, guestPrice: rupees(170) });
    const item = (await listMenu(w.db, w.staffA.waiter, w.a1)).find((m) => m.name === 'Brownie')!;
    expect(item.guestPrice).toBe(rupees(170));
  });

  it('staff cannot edit the menu or prices, and menus are per outlet', async () => {
    expect((await errorOf(addMenuItem(w.db, w.staffA.waiter, { outletId: w.a1, name: 'Free Steak', guestPrice: 0 })))?.code).toBe('forbidden');
    expect((await errorOf(updateMenuItem(w.db, w.staffA.kds, fries, { guestPrice: 1 })))?.code).toBe('forbidden');
    expect((await errorOf(listMenu(w.db, w.staffA.waiter, w.a2)))?.code).toBe('forbidden');
    expect((await errorOf(updateMenuItem(w.db, w.ownerB, fries, { guestPrice: 1 })))?.code).toBe('forbidden');
    expect((await errorOf(listMenu(w.db, w.staffA.cashier, w.a1))) === undefined).toBe(false);
  });
});

describe('player food', () => {
  it('is always free, creates no wallet debit, and is tagged to the table the player sits at', async () => {
    const p = await mkPlayer(w, w.a1, 'Hungry Hal', 1000);
    await seatPlayer(w.db, w.staffA.dealer, { sessionId, uid: p.uid });
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid, orderType: 'player' });
    expect(o.total).toBe(0);
    expect(o.payerType).toBe('none');
    expect(o.sessionId).toBe(sessionId);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(1000));
    const items = await w.db.select().from(schema.foodOrderItems).where(eq(schema.foodOrderItems.orderId, o.id));
    expect(items[0]).toMatchObject({ itemName: 'Masala Fries', quantity: 2, unitPrice: 0, lineTotal: 0 });
  });

  it('stays free even when the outlet charges guests, and the database refuses a non-zero player total', async () => {
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'chargeable' });
    const p = await mkPlayer(w, w.a1, 'Still Free', 500);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid, orderType: 'player', items: [{ menuItemId: biryani, quantity: 3 }] });
    expect(o.total).toBe(0);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(500));
    expect(await errorOf(w.db.update(schema.foodOrders).set({ total: 100 }).where(eq(schema.foodOrders.id, o.id)))).toBeDefined();
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'free' });
  });

  it('works by member search as well as by card, but never for a blocked card or inactive member', async () => {
    const p = await mkPlayer(w, w.a1, 'By Search', 0);
    expect((await order(w.staffA.waiter, { memberId: p.member.id })).order.memberId).toBe(p.member.id);
    expect((await errorOf(order(w.staffA.waiter, { uid: 'UNKNOWN-CARD' })))?.code).toBe('unknown_card');
    const { setMemberStatus } = await import('@/server/members');
    await setMemberStatus(w.db, w.ownerA, p.member.id, 'suspended', 'test');
    expect((await errorOf(order(w.staffA.waiter, { memberId: p.member.id })))?.code).toBe('blocked_card');
  });
});

describe('guest food', () => {
  it('free mode: no charge, but clearly a guest order with its guest count', async () => {
    const p = await mkPlayer(w, w.a1, 'Host Free', 300);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 2 });
    expect(o).toMatchObject({ orderType: 'guest', guestCount: 2, total: 0, payerType: 'none', paymentStatus: 'not_applicable' });
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(300));
  });

  it('needs a guest count', async () => {
    const p = await mkPlayer(w, w.a1, 'No Guests', 0);
    expect((await errorOf(order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 0 })))?.code).toBe('invalid');
  });

  it('chargeable, charged to the player: a distinct guest-food wallet debit with the payer named', async () => {
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'chargeable', guestPayer: 'player' });
    const p = await mkPlayer(w, w.a1, 'Host Pays', 1000);
    const { order: o } = await order(w.staffA.waiter, {
      uid: p.uid, orderType: 'guest', guestCount: 1, items: [{ menuItemId: fries, quantity: 2 }, { menuItemId: biryani, quantity: 1 }],
    });
    expect(o.total).toBe(rupees(580));
    expect(o).toMatchObject({ orderType: 'guest', payerType: 'player', payerMemberId: p.member.id, paymentStatus: 'paid_wallet' });
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(420));
    const [led] = await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.refId, o.orderNo));
    expect(led).toMatchObject({ type: 'guest_food', direction: 'dr', amount: rupees(580) });
  });

  it('chargeable with a short wallet: no order and the low-balance message', async () => {
    const p = await mkPlayer(w, w.a1, 'Host Short', 100);
    const before = (await orderHistory(w.db, w.staffA.waiter, w.a1)).length;
    const err = await errorOf(order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 1 }));
    expect(err?.message).toBe('Low balance. Please visit the counter to recharge.');
    expect((await orderHistory(w.db, w.staffA.waiter, w.a1)).length).toBe(before);
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(100));
  });

  it('chargeable, settled separately: no wallet debit, payment left pending, payer still identified', async () => {
    await updateSettings(w.db, w.ownerA, w.a1, { guestPayer: 'separate' });
    const p = await mkPlayer(w, w.a1, 'Host Counter', 100);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 1 });
    expect(o).toMatchObject({ total: rupees(300), payerType: 'separate', paymentStatus: 'pending_settlement', payerMemberId: p.member.id });
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(100));
  });

  it('refuses a chargeable guest order when an item has no guest price configured', async () => {
    const free = (await addMenuItem(w.db, w.ownerA, { outletId: w.a1, name: 'Unpriced', guestPrice: 0 })).id;
    const p = await mkPlayer(w, w.a1, 'Host Config', 1000);
    const err = await errorOf(order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 1, items: [{ menuItemId: free, quantity: 1 }] }));
    expect(err?.code).toBe('not_configured');
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'free', guestPayer: 'player' });
  });

  it('snapshots prices so later menu changes do not rewrite history', async () => {
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'chargeable', guestPayer: 'player' });
    const p = await mkPlayer(w, w.a1, 'Snapshot', 1000);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 1, items: [{ menuItemId: fries, quantity: 1 }] });
    await updateMenuItem(w.db, w.ownerA, fries, { guestPrice: rupees(999) });
    const [line] = await w.db.select().from(schema.foodOrderItems).where(eq(schema.foodOrderItems.orderId, o.id));
    expect(line.unitPrice).toBe(rupees(150));
    await updateMenuItem(w.db, w.ownerA, fries, { guestPrice: rupees(150) });
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'free' });
  });

  it('a reversal is how a charged guest order is refunded; cancelling does not touch money', async () => {
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'chargeable', guestPayer: 'player' });
    const p = await mkPlayer(w, w.a1, 'Refund Me', 1000);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 1, items: [{ menuItemId: fries, quantity: 2 }] });
    await updateOrderStatus(w.db, w.staffA.kds, o.id, 'cancelled', 'Guest left');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(700));
    const [led] = await w.db.select().from(schema.walletLedger).where(eq(schema.walletLedger.refId, o.orderNo));
    await reverseEntry(w.db, w.ownerA, led.id, 'Order cancelled');
    expect(await balanceOf(w.db, p.member.id, w.a1)).toBe(rupees(1000));
    await updateSettings(w.db, w.ownerA, w.a1, { guestMode: 'free' });
  });
});

describe('order rules', () => {
  it('a repeated submit returns the original order once', async () => {
    const p = await mkPlayer(w, w.a1, 'Repeat', 0);
    const k = key();
    const [a, b] = await Promise.all([order(w.staffA.waiter, { uid: p.uid, idempotencyKey: k }), order(w.staffA.waiter, { uid: p.uid, idempotencyKey: k })]);
    expect(a.order.id).toBe(b.order.id);
    expect((await w.db.select().from(schema.foodOrders).where(eq(schema.foodOrders.memberId, p.member.id))).length).toBe(1);
  });

  it('numbers orders per outlet in sequence', async () => {
    const p = await mkPlayer(w, w.a1, 'Numbers', 0);
    const a = (await order(w.staffA.waiter, { uid: p.uid })).order.orderNo;
    const b = (await order(w.staffA.waiter, { uid: p.uid })).order.orderNo;
    expect(a).toMatch(/^F-AND-\d{5}$/);
    expect(Number(b.split('-')[2])).toBe(Number(a.split('-')[2]) + 1);
  });

  it('rejects unavailable and foreign items, and empty or oversized orders', async () => {
    const p = await mkPlayer(w, w.a1, 'Bad Items', 0);
    const gone = await addMenuItem(w.db, w.ownerA, { outletId: w.a1, name: 'Sold Out', guestPrice: 100, available: false });
    expect((await errorOf(order(w.staffA.waiter, { uid: p.uid, items: [{ menuItemId: gone.id, quantity: 1 }] })))?.message).toContain('unavailable');
    const other = await addMenuItem(w.db, w.ownerA, { outletId: w.a2, name: 'Bandra Only', guestPrice: 100 });
    expect((await errorOf(order(w.staffA.waiter, { uid: p.uid, items: [{ menuItemId: other.id, quantity: 1 }] })))?.code).toBe('invalid');
    expect(await errorOf(order(w.staffA.waiter, { uid: p.uid, items: [] }))).toBeDefined();
    expect(await errorOf(order(w.staffA.waiter, { uid: p.uid, items: [{ menuItemId: fries, quantity: 99 }] }))).toBeDefined();
  });

  it('only waiters and owners can order, and only at their outlets', async () => {
    const p = await mkPlayer(w, w.a1, 'Guarded Food', 0);
    for (const ctx of [w.staffA.dealer, w.staffA.kds]) expect((await errorOf(order(ctx, { uid: p.uid })))?.code).toBe('forbidden');
    expect((await errorOf(order(w.cashierB, { uid: p.uid })))?.code).toBe('forbidden');
    expect((await errorOf(order(w.staffA.waiter, { uid: p.uid, outletId: w.a2 })))?.code).toBe('forbidden');
  });

  it('ignores any price the client tries to send', async () => {
    const p = await mkPlayer(w, w.a1, 'Price Tamper', 0);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid, items: [{ menuItemId: fries, quantity: 1, unitPrice: 99999 } as never] });
    expect(o.total).toBe(0);
  });

  it('writes orders to the audit trail', async () => {
    expect((await listAudit(w.db, w.ownerA, { category: 'Food' })).some((a) => a.action === 'Food order placed')).toBe(true);
  });
});

describe('kitchen display', () => {
  it('shows only what is needed to prepare: no prices, wallet figures or contact details', async () => {
    const p = await mkPlayer(w, w.a1, 'Table Guest', 500);
    await seatPlayer(w.db, w.staffA.dealer, { sessionId, uid: p.uid }).catch(() => undefined);
    await order(w.staffA.waiter, { uid: p.uid, orderType: 'guest', guestCount: 3 });
    const board = await kdsBoard(w.db, w.staffA.kds, w.a1);
    expect(board.length).toBeGreaterThan(0);
    const json = JSON.stringify(board);
    for (const forbidden of ['total', 'unitPrice', 'lineTotal', 'balance', 'mobile', 'passwordHash', 'payerMemberId', 'memberId']) {
      expect(json).not.toContain(forbidden);
    }
    const mine = board.find((b) => b.orderType === 'guest' && b.guestCount === 3)!;
    expect(mine.table).toBe('Food Table');
    expect(mine.items[0]).toEqual({ name: 'Masala Fries', quantity: 2 });
  });

  it('reports how long each order has been waiting, computed by the server', async () => {
    const p = await mkPlayer(w, w.a1, 'Waiting Wes', 0);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid });
    await w.db.update(schema.foodOrders).set({ createdAt: new Date(Date.now() - 12 * 60_000) }).where(eq(schema.foodOrders.id, o.id));
    const row = (await kdsBoard(w.db, w.staffA.kds, w.a1)).find((b) => b.id === o.id)!;
    expect(row.waitingMinutes).toBeGreaterThanOrEqual(12);
    expect(row.waitingMinutes).toBeLessThan(14);
  });

  it('moves orders pending → preparing → ready → served, with who and when on each step', async () => {
    const p = await mkPlayer(w, w.a1, 'Flow', 0);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid });
    for (const to of ['preparing', 'ready', 'served'] as const) {
      expect((await updateOrderStatus(w.db, w.staffA.kds, o.id, to)).status).toBe(to);
    }
    const events = await w.db.select().from(schema.foodOrderEvents).where(eq(schema.foodOrderEvents.orderId, o.id));
    expect(events.map((e) => e.newStatus)).toEqual(['pending', 'preparing', 'ready', 'served']);
    expect(events.slice(1).every((e) => e.actorId === w.staffA.kds.userId)).toBe(true);
  });

  it('allows the simpler pending → preparing → served path, and refuses skipping or going backwards', async () => {
    const p = await mkPlayer(w, w.a1, 'Skip', 0);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid });
    expect((await errorOf(updateOrderStatus(w.db, w.staffA.kds, o.id, 'served')))?.code).toBe('conflict');
    await updateOrderStatus(w.db, w.staffA.kds, o.id, 'preparing');
    expect((await errorOf(updateOrderStatus(w.db, w.staffA.kds, o.id, 'pending')))?.code).toBe('conflict');
    expect((await updateOrderStatus(w.db, w.staffA.kds, o.id, 'served')).status).toBe('served');
    expect((await errorOf(updateOrderStatus(w.db, w.staffA.kds, o.id, 'preparing')))?.code).toBe('conflict');
  });

  it('cancelling needs a reason; the kitchen can cancel a pending order but only the owner after preparation starts', async () => {
    const p = await mkPlayer(w, w.a1, 'Cancel', 0);
    const a = (await order(w.staffA.waiter, { uid: p.uid })).order;
    expect((await errorOf(updateOrderStatus(w.db, w.staffA.kds, a.id, 'cancelled')))?.code).toBe('invalid');
    expect((await updateOrderStatus(w.db, w.staffA.kds, a.id, 'cancelled', 'Out of stock')).status).toBe('cancelled');
    const b = (await order(w.staffA.waiter, { uid: p.uid })).order;
    await updateOrderStatus(w.db, w.staffA.kds, b.id, 'preparing');
    expect((await errorOf(updateOrderStatus(w.db, w.staffA.kds, b.id, 'cancelled', 'Changed mind')))?.code).toBe('forbidden');
    expect((await updateOrderStatus(w.db, w.ownerA, b.id, 'cancelled', 'Changed mind')).status).toBe('cancelled');
    const events = () => w.db.select().from(schema.foodOrderEvents).where(eq(schema.foodOrderEvents.orderId, b.id));
    const count = (await events()).length;
    expect((await updateOrderStatus(w.db, w.ownerA, b.id, 'cancelled', 'again')).status).toBe('cancelled');
    expect((await events()).length).toBe(count);
    const served = (await order(w.staffA.waiter, { uid: p.uid })).order;
    await updateOrderStatus(w.db, w.staffA.kds, served.id, 'preparing');
    await updateOrderStatus(w.db, w.staffA.kds, served.id, 'served');
    expect((await errorOf(updateOrderStatus(w.db, w.ownerA, served.id, 'cancelled', 'too late')))?.code).toBe('conflict');
  });

  it('kitchen staff cannot see menus’ prices, place orders or touch money, and waiters cannot move orders', async () => {
    const p = await mkPlayer(w, w.a1, 'Role Check', 0);
    const o = (await order(w.staffA.waiter, { uid: p.uid })).order;
    expect((await errorOf(updateOrderStatus(w.db, w.staffA.waiter, o.id, 'preparing')))?.code).toBe('forbidden');
    expect((await errorOf(kdsBoard(w.db, w.staffA.waiter, w.a1)))?.code).toBe('forbidden');
    expect((await errorOf(listMenu(w.db, w.staffA.kds, w.a1)))?.code).toBe('forbidden');
  });

  it('is scoped to the kitchen’s own outlet', async () => {
    expect((await errorOf(kdsBoard(w.db, w.staffA.kds, w.a2)))?.code).toBe('forbidden');
    expect((await errorOf(kdsBoard(w.db, w.ownerB, w.a1)))?.code).toBe('forbidden');
    const o = (await w.db.select().from(schema.foodOrders).limit(1))[0];
    expect((await errorOf(updateOrderStatus(w.db, w.ownerB, o.id, 'preparing')))?.code).toBe('forbidden');
  });

  it('hides orders served more than half an hour ago', async () => {
    const p = await mkPlayer(w, w.a1, 'Old Order', 0);
    const { order: o } = await order(w.staffA.waiter, { uid: p.uid });
    await updateOrderStatus(w.db, w.staffA.kds, o.id, 'preparing');
    await updateOrderStatus(w.db, w.staffA.kds, o.id, 'served');
    expect((await kdsBoard(w.db, w.staffA.kds, w.a1)).some((b) => b.id === o.id)).toBe(true);
    await w.db.update(schema.foodOrders).set({ createdAt: new Date(Date.now() - 3600_000) }).where(eq(schema.foodOrders.id, o.id));
    expect((await kdsBoard(w.db, w.staffA.kds, w.a1)).some((b) => b.id === o.id)).toBe(false);
  });
});
