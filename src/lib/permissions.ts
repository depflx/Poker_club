import { AppError } from './errors';

export const ROLES = ['superadmin', 'owner', 'cashier', 'dealer', 'waiter', 'kds'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES = ['cashier', 'dealer', 'waiter', 'kds'] as const;

const CASHIER = ['members.read', 'members.write', 'cards.manage', 'payments.record', 'payments.confirm', 'wallet.read', 'shift.run'];
const DEALER = ['members.read', 'wallet.read', 'floor.operate', 'chips.move', 'rounds.write', 'session.settle'];
const WAITER = ['members.read', 'food.order', 'menu.read'];
const KDS = ['kds.view', 'kds.update'];
const OWNER_ONLY = [
  'outlets.manage', 'staff.manage', 'settings.manage', 'shift.approve', 'wallet.adjust', 'round.correct',
  'reports.read', 'members.suspend', 'audit.read', 'menu.manage', 'tables.manage', 'orders.cancel',
];

export const PERMISSIONS: Record<Role, readonly string[]> = {
  superadmin: ['platform.owners', 'platform.audit', 'platform.impersonate'],
  owner: [...new Set([...CASHIER, ...DEALER, ...WAITER, ...KDS, ...OWNER_ONLY])],
  cashier: CASHIER,
  dealer: DEALER,
  waiter: WAITER,
  kds: KDS,
};

export interface Ctx {
  userId: string;
  name: string;
  role: Role;
  ownerId: string | null;
  /** Outlets this user may act in. Owners get every outlet they own; staff get their assignments. */
  outletIds: string[];
  impersonatorId: string | null;
}

export const can = (ctx: Ctx, perm: string) => PERMISSIONS[ctx.role].includes(perm);

export function requirePerm(ctx: Ctx, perm: string): void {
  if (!can(ctx, perm)) throw new AppError('forbidden', 'You do not have permission to do this.');
}

export function requireOutlet(ctx: Ctx, outletId: string): void {
  if (!ctx.outletIds.includes(outletId)) throw new AppError('forbidden', 'You do not have access to this outlet.');
}

export function requireTenant(ctx: Ctx): string {
  if (!ctx.ownerId) throw new AppError('forbidden', 'This action is only available inside an owner account.');
  return ctx.ownerId;
}
