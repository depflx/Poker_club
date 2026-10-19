import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// All money is stored in minor units (paise) as whole numbers.
const pk = () => uuid('id').primaryKey().defaultRandom();
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: 'number' });

// ---------- tenancy ----------
export const owners = pgTable(
  'owners',
  {
    id: pk(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    plan: text('plan').notNull().default('trial'),
    outletLimit: integer('outlet_limit').notNull().default(1),
    createdAt: created(),
  },
  (t) => [
    check('owners_status_ck', sql`${t.status} in ('active','suspended')`),
    check('owners_plan_ck', sql`${t.plan} in ('trial','standard','pro')`),
    check('owners_limit_ck', sql`${t.outletLimit} >= 1`),
  ],
);

export const outlets = pgTable(
  'outlets',
  {
    id: pk(),
    ownerId: uuid('owner_id').notNull().references(() => owners.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('outlets_owner_code_uq').on(t.ownerId, t.code),
    check('outlets_status_ck', sql`${t.status} in ('active','closed')`),
  ],
);

export const outletSettings = pgTable('outlet_settings', {
  outletId: uuid('outlet_id').primaryKey().references(() => outlets.id),
  guestMode: text('guest_mode').notNull().default('free'),
  guestPayer: text('guest_payer').notNull().default('player'),
  issueFee: money('issue_fee').notNull().default(10000),
  replacementFee: money('replacement_fee').notNull().default(20000),
  approvalThreshold: money('approval_threshold').notNull().default(500000),
  cashoutEnabled: boolean('cashout_enabled').notNull().default(false),
  tierFees: jsonb('tier_fees')
    .$type<Record<string, number>>()
    .notNull()
    .default(sql`'{"Bronze":50000,"Silver":100000,"Gold":250000,"Platinum":500000}'::jsonb`),
});

// ---------- identity ----------
export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    ownerId: uuid('owner_id').references(() => owners.id),
    status: text('status').notNull().default('active'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_role_ck', sql`${t.role} in ('superadmin','owner','cashier','dealer','waiter','kds')`),
    check('users_status_ck', sql`${t.status} in ('active','disabled')`),
    check('users_tenant_ck', sql`(${t.role} = 'superadmin') = (${t.ownerId} is null)`),
  ],
);

export const userOutlets = pgTable(
  'user_outlets',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
  },
  (t) => [uniqueIndex('user_outlets_uq').on(t.userId, t.outletId)],
);

export const authSessions = pgTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  impersonatorId: uuid('impersonator_id').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: created(),
});

export const loginAttempts = pgTable('login_attempts', {
  id: pk(),
  email: text('email').notNull(),
  ok: boolean('ok').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- members and cards (owner-wide) ----------
export const members = pgTable(
  'members',
  {
    id: pk(),
    ownerId: uuid('owner_id').notNull().references(() => owners.id),
    memberNumber: text('member_number').notNull(),
    name: text('name').notNull(),
    mobile: text('mobile').notNull(),
    email: text('email'),
    tier: text('tier').notNull().default('Bronze'),
    status: text('status').notNull().default('active'),
    homeOutletId: uuid('home_outlet_id').references(() => outlets.id),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('members_owner_number_uq').on(t.ownerId, t.memberNumber),
    uniqueIndex('members_owner_mobile_uq').on(t.ownerId, t.mobile),
    check('members_status_ck', sql`${t.status} in ('active','suspended','closed')`),
    check('members_tier_ck', sql`${t.tier} in ('Bronze','Silver','Gold','Platinum')`),
  ],
);

export const cards = pgTable(
  'cards',
  {
    id: pk(),
    ownerId: uuid('owner_id').notNull().references(() => owners.id),
    uid: text('uid').notNull(),
    memberId: uuid('member_id').references(() => members.id),
    status: text('status').notNull().default('unassigned'),
    reason: text('reason'),
    replacedByCardId: uuid('replaced_by_card_id'),
    issuedOutletId: uuid('issued_outlet_id').references(() => outlets.id),
    issuedBy: uuid('issued_by').references(() => users.id),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('cards_uid_uq').on(t.uid),
    uniqueIndex('cards_one_active_per_member_uq').on(t.memberId).where(sql`${t.status} = 'active'`),
    check('cards_status_ck', sql`${t.status} in ('unassigned','active','lost','replaced','damaged')`),
    check('cards_active_member_ck', sql`${t.status} <> 'active' or ${t.memberId} is not null`),
  ],
);

// ---------- money ----------
export const shifts = pgTable(
  'shifts',
  {
    id: pk(),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    cashierId: uuid('cashier_id').notNull().references(() => users.id),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    openingCash: money('opening_cash').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    expected: jsonb('expected').$type<Record<string, number>>(),
    counted: jsonb('counted').$type<Record<string, number>>(),
    discrepancy: money('discrepancy'),
    note: text('note'),
    status: text('status').notNull().default('open'),
    reviewerId: uuid('reviewer_id').references(() => users.id),
    reviewNote: text('review_note'),
  },
  (t) => [
    uniqueIndex('shifts_one_open_per_cashier_uq').on(t.outletId, t.cashierId).where(sql`${t.status} = 'open'`),
    check('shifts_status_ck', sql`${t.status} in ('open','review','approved')`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: pk(),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    memberId: uuid('member_id').notNull().references(() => members.id),
    receiptNo: text('receipt_no').notNull(),
    amount: money('amount').notNull(),
    method: text('method').notNull(),
    purpose: text('purpose').notNull(),
    status: text('status').notNull().default('pending'),
    gatewayRef: text('gateway_ref'),
    cashierId: uuid('cashier_id').notNull().references(() => users.id),
    shiftId: uuid('shift_id').references(() => shifts.id),
    cardId: uuid('card_id').references(() => cards.id),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: created(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('payments_receipt_uq').on(t.receiptNo),
    uniqueIndex('payments_idem_uq').on(t.outletId, t.idempotencyKey),
    uniqueIndex('payments_one_per_card_uq').on(t.cardId).where(sql`${t.cardId} is not null`),
    check('payments_amount_ck', sql`${t.amount} > 0`),
    check('payments_method_ck', sql`${t.method} in ('cash','upi','card')`),
    check('payments_purpose_ck', sql`${t.purpose} in ('recharge','card_issue','card_replacement')`),
    check('payments_status_ck', sql`${t.status} in ('pending','confirmed','failed')`),
  ],
);

export const wallets = pgTable(
  'wallets',
  {
    id: pk(),
    memberId: uuid('member_id').notNull().references(() => members.id),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    balance: money('balance').notNull().default(0),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    uniqueIndex('wallets_member_outlet_uq').on(t.memberId, t.outletId),
    check('wallets_balance_ck', sql`${t.balance} >= 0`),
  ],
);

export const walletLedger = pgTable(
  'wallet_ledger',
  {
    id: pk(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    memberId: uuid('member_id').notNull().references(() => members.id),
    type: text('type').notNull(),
    direction: text('direction').notNull(),
    amount: money('amount').notNull(),
    balanceAfter: money('balance_after').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    paymentId: uuid('payment_id').references(() => payments.id),
    reversalOfId: uuid('reversal_of_id'),
    reason: text('reason'),
    actorId: uuid('actor_id').references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('ledger_idem_uq').on(t.outletId, t.idempotencyKey),
    uniqueIndex('ledger_one_reversal_uq').on(t.reversalOfId).where(sql`${t.reversalOfId} is not null`),
    index('ledger_member_idx').on(t.memberId, t.createdAt),
    check('ledger_amount_ck', sql`${t.amount} > 0`),
    check('ledger_direction_ck', sql`${t.direction} in ('cr','dr')`),
    check(
      'ledger_type_ck',
      sql`${t.type} in ('recharge','chip_buy_in','chip_return','guest_food','adjustment','reversal')`,
    ),
  ],
);

// ---------- poker floor ----------
export const pokerTables = pgTable(
  'poker_tables',
  {
    id: pk(),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    name: text('name').notNull(),
    maxSeats: integer('max_seats').notNull().default(8),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    uniqueIndex('tables_outlet_name_uq').on(t.outletId, t.name),
    check('tables_seats_ck', sql`${t.maxSeats} between 2 and 8`),
  ],
);

export const pokerSessions = pgTable(
  'poker_sessions',
  {
    id: pk(),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    tableId: uuid('table_id').notNull().references(() => pokerTables.id),
    operatorId: uuid('operator_id').notNull().references(() => users.id),
    status: text('status').notNull().default('in_progress'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    exceptionAmount: money('exception_amount').notNull().default(0),
    exceptionNote: text('exception_note'),
    exceptionResolvedAt: timestamp('exception_resolved_at', { withTimezone: true }),
    exceptionResolution: text('exception_resolution'),
  },
  (t) => [
    uniqueIndex('sessions_one_open_per_table_uq').on(t.tableId).where(sql`${t.status} = 'in_progress'`),
    check('sessions_status_ck', sql`${t.status} in ('in_progress','completed','cancelled')`),
  ],
);

export const sessionPlayers = pgTable(
  'session_players',
  {
    id: pk(),
    sessionId: uuid('session_id').notNull().references(() => pokerSessions.id),
    memberId: uuid('member_id').notNull().references(() => members.id),
    seatNumber: integer('seat_number').notNull(),
    status: text('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('seat_unique_active_uq').on(t.sessionId, t.seatNumber).where(sql`${t.status} = 'active'`),
    uniqueIndex('member_one_active_seat_uq').on(t.memberId).where(sql`${t.status} = 'active'`),
    check('seat_range_ck', sql`${t.seatNumber} between 1 and 8`),
    check('seat_status_ck', sql`${t.status} in ('active','left')`),
  ],
);

export const chipTransactions = pgTable(
  'chip_transactions',
  {
    id: pk(),
    sessionId: uuid('session_id').notNull().references(() => pokerSessions.id),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    memberId: uuid('member_id').notNull().references(() => members.id),
    type: text('type').notNull(),
    amount: money('amount').notNull(),
    walletLedgerId: uuid('wallet_ledger_id').references(() => walletLedger.id),
    actorId: uuid('actor_id').notNull().references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('chips_idem_uq').on(t.outletId, t.idempotencyKey),
    check('chips_amount_ck', sql`${t.amount} > 0`),
    check('chips_type_ck', sql`${t.type} in ('issue','return')`),
  ],
);

export const rounds = pgTable(
  'rounds',
  {
    id: pk(),
    sessionId: uuid('session_id').notNull().references(() => pokerSessions.id),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    roundNumber: integer('round_number').notNull(),
    status: text('status').notNull().default('draft'),
    winnerMemberId: uuid('winner_member_id').references(() => members.id),
    pot: money('pot').notNull().default(0),
    notes: text('notes'),
    participants: jsonb('participants').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    enteredBy: uuid('entered_by').notNull().references(() => users.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('rounds_number_uq').on(t.sessionId, t.roundNumber),
    check('rounds_status_ck', sql`${t.status} in ('draft','submitted')`),
  ],
);

export const roundCorrections = pgTable('round_corrections', {
  id: pk(),
  roundId: uuid('round_id').notNull().references(() => rounds.id),
  before: jsonb('before').$type<Record<string, unknown>>().notNull(),
  after: jsonb('after').$type<Record<string, unknown>>().notNull(),
  reason: text('reason').notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  createdAt: created(),
});

// ---------- food ----------
export const menuItems = pgTable('menu_items', {
  id: pk(),
  outletId: uuid('outlet_id').notNull().references(() => outlets.id),
  name: text('name').notNull(),
  category: text('category').notNull().default('Snacks'),
  guestPrice: money('guest_price').notNull().default(0),
  available: boolean('available').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const foodOrders = pgTable(
  'food_orders',
  {
    id: pk(),
    outletId: uuid('outlet_id').notNull().references(() => outlets.id),
    orderNo: text('order_no').notNull(),
    memberId: uuid('member_id').notNull().references(() => members.id),
    sessionId: uuid('session_id').references(() => pokerSessions.id),
    tableId: uuid('table_id').references(() => pokerTables.id),
    orderType: text('order_type').notNull(),
    guestCount: integer('guest_count').notNull().default(0),
    payerType: text('payer_type').notNull().default('none'),
    payerMemberId: uuid('payer_member_id').references(() => members.id),
    status: text('status').notNull().default('pending'),
    total: money('total').notNull().default(0),
    paymentStatus: text('payment_status').notNull().default('not_applicable'),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('orders_no_uq').on(t.outletId, t.orderNo),
    uniqueIndex('orders_idem_uq').on(t.outletId, t.idempotencyKey),
    index('orders_board_idx').on(t.outletId, t.status),
    check('orders_type_ck', sql`${t.orderType} in ('player','guest')`),
    check('orders_status_ck', sql`${t.status} in ('pending','preparing','ready','served','cancelled')`),
    check('orders_player_free_ck', sql`${t.orderType} <> 'player' or ${t.total} = 0`),
  ],
);

export const foodOrderItems = pgTable('food_order_items', {
  id: pk(),
  orderId: uuid('order_id').notNull().references(() => foodOrders.id),
  menuItemId: uuid('menu_item_id').references(() => menuItems.id),
  itemName: text('item_name').notNull(),
  quantity: integer('quantity').notNull(),
  unitPrice: money('unit_price').notNull(),
  lineTotal: money('line_total').notNull(),
});

export const foodOrderEvents = pgTable('food_order_events', {
  id: pk(),
  orderId: uuid('order_id').notNull().references(() => foodOrders.id),
  priorStatus: text('prior_status'),
  newStatus: text('new_status').notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  reason: text('reason'),
  createdAt: created(),
});

// ---------- audit ----------
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    ownerId: uuid('owner_id'),
    outletId: uuid('outlet_id'),
    actorId: uuid('actor_id'),
    actorRole: text('actor_role').notNull(),
    impersonatorId: uuid('impersonator_id'),
    category: text('category').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    createdAt: created(),
  },
  (t) => [index('audit_owner_idx').on(t.ownerId, t.createdAt)],
);
