import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, can, requireOutlet, requirePerm, requireTenant, type Ctx } from '@/lib/permissions';
import { AppError, MESSAGES } from '@/lib/errors';
import { formatINR, rupees, assertAmount } from '@/lib/money';

const ctx = (role: Ctx['role'], extra: Partial<Ctx> = {}): Ctx => ({
  userId: 'u', name: 'n', role, ownerId: role === 'superadmin' ? null : 'o', outletIds: ['x'], impersonatorId: null, ...extra,
});

describe('permission matrix', () => {
  const expectations: Record<string, Record<string, boolean>> = {
    'platform.owners': { superadmin: true },
    'platform.audit': { superadmin: true },
    'platform.impersonate': { superadmin: true },
    'outlets.manage': { owner: true },
    'staff.manage': { owner: true },
    'settings.manage': { owner: true },
    'shift.approve': { owner: true },
    'wallet.adjust': { owner: true },
    'round.correct': { owner: true },
    'reports.read': { owner: true },
    'menu.manage': { owner: true },
    'tables.manage': { owner: true },
    'orders.cancel': { owner: true },
    'members.suspend': { owner: true },
    'audit.read': { owner: true },
    'cards.manage': { owner: true, cashier: true },
    'payments.record': { owner: true, cashier: true },
    'payments.confirm': { owner: true, cashier: true },
    'shift.run': { owner: true, cashier: true },
    'members.write': { owner: true, cashier: true },
    'floor.operate': { owner: true, dealer: true },
    'chips.move': { owner: true, dealer: true },
    'rounds.write': { owner: true, dealer: true },
    'session.settle': { owner: true, dealer: true },
    'food.order': { owner: true, waiter: true },
    'menu.read': { owner: true, waiter: true },
    'kds.view': { owner: true, kds: true },
    'kds.update': { owner: true, kds: true },
    'members.read': { owner: true, cashier: true, dealer: true, waiter: true },
    'wallet.read': { owner: true, cashier: true, dealer: true },
  };

  for (const [perm, allowed] of Object.entries(expectations)) {
    it(`${perm} is granted to exactly ${Object.keys(allowed).join(', ')}`, () => {
      for (const role of ROLES) expect(can(ctx(role), perm), `${role} → ${perm}`).toBe(!!allowed[role]);
    });
  }

  it('every permission that exists is covered by the matrix above', () => {
    const known = new Set(Object.keys(expectations));
    for (const role of ROLES) for (const p of PERMISSIONS[role]) expect(known.has(p), `${p} missing from matrix`).toBe(true);
  });

  it('the kitchen and waiter roles never handle money, and the superadmin has no club permissions', () => {
    for (const p of ['payments.record', 'wallet.adjust', 'wallet.read', 'chips.move', 'cards.manage']) {
      expect(can(ctx('kds'), p)).toBe(false);
      expect(can(ctx('waiter'), p)).toBe(false);
    }
    expect(PERMISSIONS.superadmin.every((p) => p.startsWith('platform.'))).toBe(true);
  });

  it('requirePerm and requireOutlet throw forbidden errors with a readable message', () => {
    expect(() => requirePerm(ctx('waiter'), 'wallet.adjust')).toThrowError(AppError);
    expect(() => requirePerm(ctx('owner'), 'wallet.adjust')).not.toThrow();
    expect(() => requireOutlet(ctx('cashier'), 'other')).toThrowError('You do not have access to this outlet.');
    expect(() => requireOutlet(ctx('cashier'), 'x')).not.toThrow();
    expect(() => requireTenant(ctx('superadmin'))).toThrowError(AppError);
    expect(requireTenant(ctx('owner'))).toBe('o');
  });
});

describe('PRD wording and money helpers', () => {
  it('uses the exact required messages', () => {
    expect(MESSAGES.low_balance).toBe('Low balance. Please visit the counter to recharge.');
    expect(MESSAGES.blocked_card).toBe('This card is blocked. Please visit the counter.');
    expect(MESSAGES.unknown_card).toBe('Card not recognized. Verify the card or contact the counter.');
    expect(MESSAGES.duplicate_card).toBe('This card is already registered. No changes were made.');
    expect(MESSAGES.table_full).toBe('This table has reached its 8-player limit.');
    expect(MESSAGES.already_seated).toBe('This player is already active at a table.');
    expect(MESSAGES.payment_pending).toBe('Payment is pending confirmation. Wallet has not been credited yet.');
  });

  it('AppError carries the PRD message by default', () => {
    expect(new AppError('low_balance').message).toBe(MESSAGES.low_balance);
    expect(new AppError('forbidden', 'custom').message).toBe('custom');
  });

  it('formats rupees with Indian grouping and handles paise', () => {
    expect(formatINR(rupees(1500))).toBe('₹1,500');
    expect(formatINR(rupees(125000))).toBe('₹1,25,000');
    expect(formatINR(rupees(12.5))).toBe('₹12.5');
    expect(formatINR(-rupees(120))).toBe('−₹120');
  });

  it('validates whole positive paise amounts', () => {
    expect(assertAmount(100)).toBe(100);
    for (const bad of [0, -1, 1.5, '5', NaN, null]) expect(() => assertAmount(bad)).toThrow();
  });
});
