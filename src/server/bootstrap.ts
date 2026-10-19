import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@/db/client';
import type { DB } from '@/db/client';
import { rupees } from '@/lib/money';
import { buildCtx, hashPassword } from './auth';
import { issueCard } from './cards';
import { addMenuItem, placeOrder, updateOrderStatus } from './food';
import { createMember } from './members';
import { createOutlet } from './outlets';
import { recordPayment } from './payments';
import { createRound, createTable, issueChips, openSession, seatPlayer } from './poker';
import { openShift } from './shifts';
import { createStaff } from './staff';
import { createOwner } from './superadmin';

export const DEMO = {
  superadmin: { email: 'admin@depflx.test', password: 'Admin#12345' },
  owner: { email: 'owner@demo.club', password: 'Owner#12345' },
  staff: { password: 'Staff#12345', cashier: 'cashier@demo.club', dealer: 'dealer@demo.club', waiter: 'waiter@demo.club', kds: 'kds@demo.club' },
};

/** First-run setup: make sure a superadmin exists, and optionally load a demo club. */
export async function bootstrap(db: DB) {
  const [sa] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, 'superadmin')).limit(1);
  const demo = process.env.DEMO_SEED === '1';
  if (!sa) {
    const email = process.env.SUPERADMIN_EMAIL ?? (demo ? DEMO.superadmin.email : undefined);
    const password = process.env.SUPERADMIN_PASSWORD ?? (demo ? DEMO.superadmin.password : undefined);
    if (email && password) {
      await db.insert(schema.users).values({
        email: email.toLowerCase(), name: 'DepFlx Admin', passwordHash: await hashPassword(password), role: 'superadmin',
      });
    }
  }
  if (demo) await seedDemo(db);
}

const key = () => randomUUID();

/** A believable evening at a two-outlet club, built through the real services so the audit trail is real too. */
export async function seedDemo(db: DB) {
  const [existing] = await db.select({ id: schema.owners.id }).from(schema.owners).limit(1);
  if (existing) return;
  const [saUser] = await db.select().from(schema.users).where(eq(schema.users.role, 'superadmin')).limit(1);
  const sa = await buildCtx(db, saUser.id);

  const created = await createOwner(db, sa, {
    name: 'Aces Poker Club', plan: 'pro', outletLimit: 3, ownerName: 'Priya Shetty',
    ownerEmail: DEMO.owner.email, password: DEMO.owner.password, firstOutlet: { name: 'Andheri', code: 'AND' },
  });
  let owner = await buildCtx(db, created.ownerUser.id);
  const andheri = created.outletId!;
  const bandra = (await createOutlet(db, owner, { name: 'Bandra', code: 'BAN' })).id;
  owner = await buildCtx(db, created.ownerUser.id);

  const mk = async (name: string, email: string, role: 'cashier' | 'dealer' | 'waiter' | 'kds', outletIds: string[]) =>
    buildCtx(db, (await createStaff(db, owner, { name, email, role, password: DEMO.staff.password, outletIds })).id);
  const cashier = await mk('Ravi Kulkarni', DEMO.staff.cashier, 'cashier', [andheri, bandra]);
  const dealer = await mk('Imran Qureshi', DEMO.staff.dealer, 'dealer', [andheri]);
  const waiter = await mk('Sunil Pawar', DEMO.staff.waiter, 'waiter', [andheri]);
  const kds = await mk('Meena Das', DEMO.staff.kds, 'kds', [andheri]);

  for (const [name, category, price] of [
    ['Masala Fries', 'Snacks', 150], ['Chicken Sandwich', 'Mains', 250], ['Paneer Tikka', 'Starters', 300],
    ['Veg Biryani', 'Mains', 280], ['Nachos', 'Snacks', 180], ['Brownie', 'Dessert', 160],
  ] as const) {
    await addMenuItem(db, owner, { outletId: andheri, name, category, guestPrice: rupees(price) });
  }
  await addMenuItem(db, owner, { outletId: bandra, name: 'House Fries', category: 'Snacks', guestPrice: rupees(140) });

  const names = ['Arjun Mehta', 'Kavya Rao', 'Rohit Shah', 'Neha Iyer', 'Vikram Singh', 'Anita Desai', 'Sameer Khan', 'Divya Nair', 'Karan Malhotra', 'Pooja Reddy', 'Aditya Verma', 'Lata Pillai', 'Ishaan Gupta', 'Meera Joshi'];
  const tiers = ['Bronze', 'Silver', 'Gold', 'Platinum'] as const;
  await openShift(db, cashier, { outletId: andheri, openingCash: rupees(5000) });
  const players: { id: string; uid: string }[] = [];
  for (const [i, name] of names.entries()) {
    const m = await createMember(db, cashier, { outletId: andheri, name, mobile: `98${String(20000000 + i * 1234567).slice(0, 8)}`, tier: tiers[(i * 3 + 1) % 4] });
    const uid = `NFC-A${1001 + i}`;
    await issueCard(db, cashier, { outletId: andheri, memberId: m.id, uid, method: 'cash', idempotencyKey: key() });
    await recordPayment(db, cashier, {
      outletId: andheri, memberId: m.id, amount: rupees(3000 + i * 500), method: i % 3 === 0 ? 'card' : 'cash', purpose: 'recharge', idempotencyKey: key(),
    });
    players.push({ id: m.id, uid });
  }
  await recordPayment(db, cashier, { outletId: andheri, memberId: players[10].id, amount: rupees(1500), method: 'upi', purpose: 'recharge', idempotencyKey: key() });

  const table = async (name: string, ids: number[]) => {
    const t = await createTable(db, owner, { outletId: andheri, name });
    if (!ids.length) return;
    const s = await openSession(db, dealer, t.id);
    for (const [n, i] of ids.entries()) {
      await seatPlayer(db, dealer, { sessionId: s.id, uid: players[i].uid });
      await issueChips(db, dealer, { sessionId: s.id, memberId: players[i].id, amount: rupees(500 + (n + 1) * 500), idempotencyKey: key() });
    }
    await createRound(db, dealer, { sessionId: s.id, participants: ids.slice(0, 3).map((i) => players[i].id), winnerMemberId: players[ids[1]].id, pot: rupees(2400), submit: true });
    return s;
  };
  await table('Table 1', [12, 13]);
  await table('Table 2', [0, 1, 2, 3, 4, 5, 6, 7]);
  await table('Table 3', [8, 9]);
  await table('Table 4', []);
  await createTable(db, owner, { outletId: bandra, name: 'Table 1' });
  await createTable(db, owner, { outletId: bandra, name: 'Table 2' });

  const menu = await db.select().from(schema.menuItems).where(eq(schema.menuItems.outletId, andheri));
  const fries = menu.find((m) => m.name === 'Masala Fries')!;
  const nachos = menu.find((m) => m.name === 'Nachos')!;
  await placeOrder(db, waiter, { outletId: andheri, uid: players[0].uid, orderType: 'player', items: [{ menuItemId: fries.id, quantity: 2 }], idempotencyKey: key() });
  const guest = await placeOrder(db, waiter, { outletId: andheri, uid: players[3].uid, orderType: 'guest', guestCount: 1, items: [{ menuItemId: nachos.id, quantity: 1 }], idempotencyKey: key() });
  await updateOrderStatus(db, kds, guest.order.id, 'preparing');
}
