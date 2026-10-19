'use server';

import { getDb } from '@/db/client';
import { act, rupeesToPaise, safeBack, str } from '@/lib/act';
import { formatINR } from '@/lib/money';
import { requireCtx } from '@/lib/session';
import { addMenuItem, updateMenuItem } from '@/server/food';
import { setMemberStatus } from '@/server/members';
import { createOutlet, updateOutlet, updateSettings } from '@/server/outlets';
import { confirmPayment, failPayment } from '@/server/payments';
import { correctRound, createTable, resolveException, updateTable } from '@/server/poker';
import { approveShift, rejectShift } from '@/server/shifts';
import { createStaff, resetStaffPassword, updateStaff } from '@/server/staff';
import { adjustWallet, reverseEntry } from '@/server/wallet';

const back = (fd: FormData, fallback = '/owner') => safeBack(fd.get('_back'), fallback);
const owner = () => requireCtx(['owner']);

// ---------- shifts and money ----------
export async function approveShiftAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    await approveShift(await getDb(), ctx, str(fd, 'shiftId'), str(fd, 'note') || undefined);
    return 'Shift approved and locked.';
  });
}

export async function rejectShiftAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    await rejectShift(await getDb(), ctx, str(fd, 'shiftId'), str(fd, 'reason'));
    return 'Sent back to the cashier to recount.';
  });
}

export async function ownerConfirmPaymentAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    const { replayed } = await confirmPayment(await getDb(), ctx, str(fd, 'paymentId'), { gatewayRef: str(fd, 'ref') });
    return replayed ? 'Already confirmed. Nothing was credited twice.' : 'Payment confirmed. Wallet credited.';
  });
}

export async function ownerFailPaymentAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    await failPayment(await getDb(), ctx, str(fd, 'paymentId'), str(fd, 'reason'));
    return 'Payment marked failed. The wallet was not credited.';
  });
}

export async function adjustWalletAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    const e = await adjustWallet(await getDb(), ctx, {
      outletId: str(fd, 'outletId'),
      memberId: str(fd, 'memberId'),
      direction: str(fd, 'direction') as 'cr' | 'dr',
      amount: rupeesToPaise(fd, 'amount'),
      reason: str(fd, 'reason'),
      idempotencyKey: str(fd, '_key'),
    });
    return `Adjustment posted. Balance is now ${formatINR(e.balanceAfter)}.`;
  });
}

export async function reverseEntryAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    await reverseEntry(await getDb(), ctx, str(fd, 'ledgerId'), str(fd, 'reason'));
    return 'Entry reversed. The original stays on record.';
  });
}

export async function setMemberStatusAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    const status = str(fd, 'status') as 'active' | 'suspended';
    const m = await setMemberStatus(await getDb(), ctx, str(fd, 'memberId'), status, str(fd, 'reason'));
    return `${m.name} is now ${status}.`;
  });
}

// ---------- floor ----------
export async function correctRoundAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    await correctRound(await getDb(), ctx, str(fd, 'roundId'), {
      winnerMemberId: str(fd, 'winner') || null,
      pot: fd.get('pot') ? rupeesToPaise(fd, 'pot') : undefined,
      reason: str(fd, 'reason'),
    });
    return 'Correction recorded. The original entry is kept.';
  });
}

export async function resolveExceptionAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd), async () => {
    await resolveException(await getDb(), ctx, str(fd, 'sessionId'), str(fd, 'resolution'));
    return 'Chip exception resolved.';
  });
}

export async function createTableAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=tables'), async () => {
    const t = await createTable(await getDb(), ctx, {
      outletId: str(fd, 'outletId'), name: str(fd, 'name'), maxSeats: Number(str(fd, 'maxSeats') || 8),
    });
    return `${t.name} added with ${t.maxSeats} seats.`;
  });
}

export async function updateTableAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=tables'), async () => {
    const t = await updateTable(await getDb(), ctx, str(fd, 'tableId'), { active: str(fd, 'active') === 'true' });
    return `${t.name} is ${t.active ? 'in use' : 'switched off'}.`;
  });
}

// ---------- settings ----------
export async function updateSettingsAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings'), async () => {
    await updateSettings(await getDb(), ctx, str(fd, 'outletId'), {
      guestMode: str(fd, 'guestMode') as 'free' | 'chargeable',
      guestPayer: str(fd, 'guestPayer') as 'player' | 'separate',
      issueFee: rupeesToPaise(fd, 'issueFee'),
      replacementFee: rupeesToPaise(fd, 'replacementFee'),
      approvalThreshold: rupeesToPaise(fd, 'approvalThreshold'),
      tierFees: {
        Bronze: rupeesToPaise(fd, 'tier_Bronze'), Silver: rupeesToPaise(fd, 'tier_Silver'),
        Gold: rupeesToPaise(fd, 'tier_Gold'), Platinum: rupeesToPaise(fd, 'tier_Platinum'),
      },
    });
    return 'Settings saved for this outlet.';
  });
}

export async function addMenuItemAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=menu'), async () => {
    const i = await addMenuItem(await getDb(), ctx, {
      outletId: str(fd, 'outletId'), name: str(fd, 'name'), category: str(fd, 'category') || 'Snacks', guestPrice: rupeesToPaise(fd, 'guestPrice'),
    });
    return `${i.name} added to the menu.`;
  });
}

export async function updateMenuItemAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=menu'), async () => {
    const patch: { guestPrice?: number; available?: boolean } = {};
    if (fd.get('guestPrice') !== null) patch.guestPrice = rupeesToPaise(fd, 'guestPrice');
    if (fd.get('available') !== null) patch.available = str(fd, 'available') === 'true';
    const i = await updateMenuItem(await getDb(), ctx, str(fd, 'itemId'), patch);
    return patch.available !== undefined ? `${i.name} is ${i.available ? 'available' : 'hidden from waiters'}.` : `${i.name} saved.`;
  });
}

export async function createOutletAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=outlets'), async () => {
    const o = await createOutlet(await getDb(), ctx, { name: str(fd, 'name'), code: str(fd, 'code') });
    return `${o.name} is open for business. Assign staff to it next.`;
  });
}

export async function updateOutletAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=outlets'), async () => {
    const status = str(fd, 'status');
    const o = await updateOutlet(await getDb(), ctx, str(fd, 'outletId'), {
      name: str(fd, 'name') || undefined,
      status: status ? (status as 'active' | 'closed') : undefined,
    });
    return `${o.name} saved.`;
  });
}

export async function createStaffAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=staff'), async () => {
    const u = await createStaff(await getDb(), ctx, {
      name: str(fd, 'name'), email: str(fd, 'email'), role: str(fd, 'role') as 'cashier' | 'dealer' | 'waiter' | 'kds',
      password: String(fd.get('password') ?? ''), outletIds: fd.getAll('outletIds').map(String),
    });
    return `${u.name} can sign in now.`;
  });
}

export async function updateStaffAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=staff'), async () => {
    const outletIds = fd.getAll('outletIds').map(String);
    const role = str(fd, 'role');
    const status = str(fd, 'status');
    const u = await updateStaff(await getDb(), ctx, str(fd, 'userId'), {
      role: role ? (role as 'cashier' | 'dealer' | 'waiter' | 'kds') : undefined,
      status: status ? (status as 'active' | 'disabled') : undefined,
      outletIds: outletIds.length ? outletIds : undefined,
    });
    return `${u.name} updated. They were signed out of any open sessions.`;
  });
}

export async function resetStaffPasswordAction(fd: FormData) {
  const ctx = await owner();
  await act(back(fd, '/owner/settings?t=staff'), async () => {
    await resetStaffPassword(await getDb(), ctx, str(fd, 'userId'), String(fd.get('password') ?? ''));
    return 'Password reset. They were signed out.';
  });
}
