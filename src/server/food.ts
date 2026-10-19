import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { AppError } from '@/lib/errors';
import { can, requireOutlet, requirePerm, type Ctx } from '@/lib/permissions';
import { audit } from './audit';
import { lookupCard } from './cards';
import type { Tx } from './db-types';
import { getMember } from './members';
import { getSettings } from './outlets';
import { postLedger } from './wallet';

const { menuItems, foodOrders, foodOrderItems, foodOrderEvents, outlets, pokerSessions, pokerTables, sessionPlayers, members } = schema;

// ---------- menu ----------
const MenuItem = z.object({
  outletId: z.string().uuid(),
  name: z.string().trim().min(2),
  category: z.string().trim().min(1).default('Snacks'),
  guestPrice: z.number().int().min(0).default(0),
  available: z.boolean().default(true),
});

export async function addMenuItem(db: DB, ctx: Ctx, raw: z.input<typeof MenuItem>) {
  requirePerm(ctx, 'menu.manage');
  const input = MenuItem.parse(raw);
  requireOutlet(ctx, input.outletId);
  return db.transaction(async (tx) => {
    const [item] = await tx.insert(menuItems).values(input).returning();
    await audit(tx, ctx, {
      category: 'Settings', action: 'Menu item added', entityType: 'menu_item', entityId: item.id, outletId: input.outletId,
      after: { name: item.name, guestPrice: item.guestPrice },
    });
    return item;
  });
}

export async function updateMenuItem(db: DB, ctx: Ctx, itemId: string, patch: { name?: string; category?: string; guestPrice?: number; available?: boolean }) {
  requirePerm(ctx, 'menu.manage');
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(menuItems).where(eq(menuItems.id, itemId)).for('update');
    if (!before) throw new AppError('not_found', 'Menu item not found.');
    requireOutlet(ctx, before.outletId);
    if (patch.guestPrice !== undefined) z.number().int().min(0).parse(patch.guestPrice);
    const [after] = await tx
      .update(menuItems)
      .set({
        name: patch.name?.trim() || before.name,
        category: patch.category ?? before.category,
        guestPrice: patch.guestPrice ?? before.guestPrice,
        available: patch.available ?? before.available,
      })
      .where(eq(menuItems.id, itemId))
      .returning();
    await audit(tx, ctx, {
      category: 'Settings', action: 'Menu item changed', entityType: 'menu_item', entityId: itemId, outletId: before.outletId,
      before: { name: before.name, guestPrice: before.guestPrice, available: before.available },
      after: { name: after.name, guestPrice: after.guestPrice, available: after.available },
    });
    return after;
  });
}

/** Waiters see only what they can sell; the owner also sees unavailable items. */
export async function listMenu(db: DB, ctx: Ctx, outletId: string) {
  requirePerm(ctx, 'menu.read');
  requireOutlet(ctx, outletId);
  const rows = await db.select().from(menuItems).where(eq(menuItems.outletId, outletId)).orderBy(asc(menuItems.sortOrder), asc(menuItems.name));
  return can(ctx, 'menu.manage') ? rows : rows.filter((r) => r.available);
}

// ---------- orders ----------
const Order = z
  .object({
    outletId: z.string().uuid(),
    uid: z.string().trim().min(1).optional(),
    memberId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    orderType: z.enum(['player', 'guest']),
    guestCount: z.number().int().min(0).max(20).default(0),
    items: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1).max(20) })).min(1, 'Add at least one item.'),
    idempotencyKey: z.string().min(8),
  })
  .refine((o) => o.uid || o.memberId, { message: 'Tap the player card or pick a member.' });

async function nextOrderNo(tx: Tx, outletId: string) {
  const [o] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).for('update');
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(foodOrders).where(eq(foodOrders.outletId, outletId));
  return `F-${o.code}-${String(n + 1).padStart(5, '0')}`;
}

/** Prices are decided here on the server. A player order is always zero, whatever the client sends. */
export async function placeOrder(db: DB, ctx: Ctx, raw: z.input<typeof Order>) {
  requirePerm(ctx, 'food.order');
  const input = Order.parse(raw);
  requireOutlet(ctx, input.outletId);
  const settings = await getSettings(db, ctx, input.outletId);
  return db.transaction(async (tx) => {
    const [dup] = await tx
      .select()
      .from(foodOrders)
      .where(and(eq(foodOrders.outletId, input.outletId), eq(foodOrders.idempotencyKey, input.idempotencyKey)));
    if (dup) return { order: dup, replayed: true };

    const member = input.uid ? (await lookupCard(tx, ctx, input.uid)).member : await getMember(tx, ctx, input.memberId!);
    if (member.status !== 'active') throw new AppError('blocked_card', 'This member is not active. Please visit the counter.');
    if (input.orderType === 'guest' && input.guestCount < 1) throw new AppError('invalid', 'Enter how many guests this order is for.');

    let sessionId: string | null = input.sessionId ?? null;
    let tableId: string | null = null;
    if (sessionId) {
      const [s] = await tx.select().from(pokerSessions).where(eq(pokerSessions.id, sessionId));
      if (!s || s.outletId !== input.outletId || s.status !== 'in_progress') throw new AppError('invalid', 'That table session is not running.');
      tableId = s.tableId;
    } else {
      const [seat] = await tx
        .select({ s: pokerSessions })
        .from(sessionPlayers)
        .innerJoin(pokerSessions, eq(pokerSessions.id, sessionPlayers.sessionId))
        .where(and(eq(sessionPlayers.memberId, member.id), eq(sessionPlayers.status, 'active'), eq(pokerSessions.outletId, input.outletId)));
      if (seat) {
        sessionId = seat.s.id;
        tableId = seat.s.tableId;
      }
    }

    const ids = input.items.map((i) => i.menuItemId);
    const menu = await tx.select().from(menuItems).where(and(eq(menuItems.outletId, input.outletId), inArray(menuItems.id, ids)));
    const lines = input.items.map((i) => {
      const m = menu.find((x) => x.id === i.menuItemId);
      if (!m) throw new AppError('invalid', 'One of those items is not on this outlet’s menu.');
      if (!m.available) throw new AppError('invalid', `${m.name} is unavailable right now.`);
      return { m, quantity: i.quantity };
    });

    const chargeable = input.orderType === 'guest' && settings.guestMode === 'chargeable';
    if (chargeable && lines.some((l) => l.m.guestPrice <= 0)) throw new AppError('not_configured');
    const priced = lines.map((l) => ({ ...l, unit: chargeable ? l.m.guestPrice : 0 }));
    const total = priced.reduce((a, l) => a + l.unit * l.quantity, 0);

    const orderNo = await nextOrderNo(tx, input.outletId);
    let payerType = 'none';
    let paymentStatus = 'not_applicable';
    if (chargeable && total > 0) {
      if (settings.guestPayer === 'player') {
        payerType = 'player';
        paymentStatus = 'paid_wallet';
        await postLedger(tx, {
          outletId: input.outletId, memberId: member.id, type: 'guest_food', direction: 'dr', amount: total,
          refType: 'food_order', refId: orderNo, actorId: ctx.userId, idempotencyKey: `food:${input.idempotencyKey}`,
        });
      } else {
        payerType = 'separate';
        paymentStatus = 'pending_settlement';
      }
    }

    const [order] = await tx
      .insert(foodOrders)
      .values({
        outletId: input.outletId, orderNo, memberId: member.id, sessionId, tableId, orderType: input.orderType,
        guestCount: input.orderType === 'guest' ? input.guestCount : 0, payerType,
        payerMemberId: payerType === 'player' ? member.id : input.orderType === 'guest' ? member.id : null,
        total, paymentStatus, createdBy: ctx.userId, idempotencyKey: input.idempotencyKey,
      })
      .returning();
    await tx.insert(foodOrderItems).values(
      priced.map((l) => ({
        orderId: order.id, menuItemId: l.m.id, itemName: l.m.name, quantity: l.quantity, unitPrice: l.unit, lineTotal: l.unit * l.quantity,
      })),
    );
    await tx.insert(foodOrderEvents).values({ orderId: order.id, priorStatus: null, newStatus: 'pending', actorId: ctx.userId });
    await audit(tx, ctx, {
      category: 'Food', action: 'Food order placed', entityType: 'food_order', entityId: order.id, outletId: input.outletId,
      after: { orderNo, type: input.orderType, total, payerType },
    });
    return { order, replayed: false };
  });
}

// ---------- kitchen ----------
type Status = 'pending' | 'preparing' | 'ready' | 'served' | 'cancelled';
const FORWARD: Record<string, Status[]> = {
  pending: ['preparing'],
  preparing: ['ready', 'served'],
  ready: ['served'],
};

/** Moves an order along the kitchen workflow. Each move is recorded with who and when. */
export async function updateOrderStatus(db: DB, ctx: Ctx, orderId: string, to: Status, reason?: string) {
  requirePerm(ctx, 'kds.update');
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(foodOrders).where(eq(foodOrders.id, orderId)).for('update');
    if (!o) throw new AppError('not_found', 'Order not found.');
    requireOutlet(ctx, o.outletId);
    if (to === o.status) return o;
    if (to === 'cancelled') {
      if (!reason?.trim()) throw new AppError('invalid', 'Give a reason for cancelling.');
      if (o.status === 'served' || o.status === 'cancelled') throw new AppError('conflict', `A ${o.status} order cannot be cancelled.`);
      if (o.status !== 'pending' && !can(ctx, 'orders.cancel')) {
        throw new AppError('forbidden', 'Once preparation has started, only the owner can cancel an order.');
      }
    } else if (!FORWARD[o.status]?.includes(to)) {
      throw new AppError('conflict', `An order cannot go from ${o.status} to ${to}.`);
    }
    const [after] = await tx.update(foodOrders).set({ status: to }).where(eq(foodOrders.id, orderId)).returning();
    await tx.insert(foodOrderEvents).values({ orderId, priorStatus: o.status, newStatus: to, actorId: ctx.userId, reason });
    await audit(tx, ctx, {
      category: 'Food', action: `Food order ${to}`, entityType: 'food_order', entityId: orderId, outletId: o.outletId,
      before: { status: o.status }, after: { status: to }, reason,
    });
    return after;
  });
}

/**
 * The kitchen board: only what is needed to prepare and serve. No prices, wallet figures or member contact details.
 */
export async function kdsBoard(db: DB, ctx: Ctx, outletId: string) {
  requirePerm(ctx, 'kds.view');
  requireOutlet(ctx, outletId);
  const since = new Date(Date.now() - 30 * 60 * 1000);
  const orders = await db
    .select({ o: foodOrders, table: pokerTables.name })
    .from(foodOrders)
    .leftJoin(pokerTables, eq(pokerTables.id, foodOrders.tableId))
    .where(and(eq(foodOrders.outletId, outletId), inArray(foodOrders.status, ['pending', 'preparing', 'ready', 'served'])))
    .orderBy(asc(foodOrders.createdAt));
  const live = orders.filter((r) => r.o.status !== 'served' || r.o.createdAt >= since);
  if (!live.length) return [];
  const items = await db.select().from(foodOrderItems).where(inArray(foodOrderItems.orderId, live.map((r) => r.o.id)));
  const seats = await db
    .select()
    .from(sessionPlayers)
    .where(and(eq(sessionPlayers.status, 'active'), inArray(sessionPlayers.memberId, live.map((r) => r.o.memberId))));
  return live.map(({ o, table }) => ({
    id: o.id,
    orderNo: o.orderNo,
    status: o.status as Status,
    orderType: o.orderType as 'player' | 'guest',
    guestCount: o.guestCount,
    table,
    seat: seats.find((s) => s.memberId === o.memberId && s.sessionId === o.sessionId)?.seatNumber ?? null,
    createdAt: o.createdAt,
    waitingMinutes: Math.max(0, Math.round((Date.now() - o.createdAt.getTime()) / 60000)),
    items: items.filter((i) => i.orderId === o.id).map((i) => ({ name: i.itemName, quantity: i.quantity })),
  }));
}

export async function orderHistory(db: DB, ctx: Ctx, outletId: string, limit = 50) {
  requirePerm(ctx, 'food.order');
  requireOutlet(ctx, outletId);
  return db
    .select({ order: foodOrders, memberName: members.name })
    .from(foodOrders)
    .innerJoin(members, eq(members.id, foodOrders.memberId))
    .where(eq(foodOrders.outletId, outletId))
    .orderBy(desc(foodOrders.createdAt))
    .limit(limit);
}
