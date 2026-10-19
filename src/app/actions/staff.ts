'use server';

import { getDb } from '@/db/client';
import { act, rupeesToPaise, safeBack, str } from '@/lib/act';
import { formatINR } from '@/lib/money';
import { requireCtx } from '@/lib/session';
import { blockCard, issueCard, replaceCard } from '@/server/cards';
import { placeOrder, updateOrderStatus } from '@/server/food';
import { createMember } from '@/server/members';
import { confirmPayment, failPayment, recordPayment } from '@/server/payments';
import {
  closeSession, createRound, issueChips, leaveSeat, openSession, returnChips, seatPlayer, submitRound,
} from '@/server/poker';
import { closeShift, openShift } from '@/server/shifts';

const back = (fd: FormData, fallback: string) => safeBack(fd.get('_back'), fallback);
const cashier = () => requireCtx(['cashier']);
const dealer = () => requireCtx(['dealer']);
const waiter = () => requireCtx(['waiter']);
const kitchen = () => requireCtx(['kds']);

type Method = 'cash' | 'card' | 'upi';

// ---------- cashier ----------
export async function createMemberAction(fd: FormData) {
  const ctx = await cashier();
  let to = back(fd, '/staff/counter');
  await act(to, async () => {
    const m = await createMember(await getDb(), ctx, {
      outletId: str(fd, 'outletId'), name: str(fd, 'name'), mobile: str(fd, 'mobile'), email: str(fd, 'email') || undefined,
      tier: (str(fd, 'tier') || 'Bronze') as 'Bronze' | 'Silver' | 'Gold' | 'Platinum',
    });
    to = `/staff/counter?o=${str(fd, 'outletId')}&m=${m.id}`;
    return { to, msg: `${m.name} is registered as ${m.memberNumber}. Issue a card next.` };
  });
}

export async function recordPaymentAction(fd: FormData) {
  const ctx = await cashier();
  const b = back(fd, '/staff/counter');
  await act(b, async () => {
    const { payment, replayed } = await recordPayment(await getDb(), ctx, {
      outletId: str(fd, 'outletId'), memberId: str(fd, 'memberId'), amount: rupeesToPaise(fd, 'amount'),
      method: str(fd, 'method') as Method, purpose: 'recharge', idempotencyKey: str(fd, '_key'),
    });
    const sep = b.includes('?') ? '&' : '?';
    const to = `${b.replace(/[?&]r=[^&]*/, '')}${sep}r=${payment.id}`;
    if (replayed) return { to, msg: 'That payment was already recorded. Nothing was added twice.' };
    return {
      to,
      msg: payment.status === 'pending'
        ? 'Payment is pending confirmation. Wallet has not been credited yet.'
        : `${formatINR(payment.amount)} recorded. Wallet credited. Receipt ${payment.receiptNo}.`,
    };
  });
}

export async function confirmPaymentAction(fd: FormData) {
  const ctx = await cashier();
  await act(back(fd, '/staff/counter'), async () => {
    const { replayed } = await confirmPayment(await getDb(), ctx, str(fd, 'paymentId'), { gatewayRef: str(fd, 'ref') });
    return replayed ? 'Already confirmed. Nothing was credited twice.' : 'Payment confirmed. Wallet credited.';
  });
}

export async function failPaymentAction(fd: FormData) {
  const ctx = await cashier();
  await act(back(fd, '/staff/counter'), async () => {
    await failPayment(await getDb(), ctx, str(fd, 'paymentId'), str(fd, 'reason'));
    return 'Payment marked failed. The wallet was not credited.';
  });
}

export async function issueCardAction(fd: FormData) {
  const ctx = await cashier();
  await act(back(fd, '/staff/counter'), async () => {
    const c = await issueCard(await getDb(), ctx, {
      outletId: str(fd, 'outletId'), memberId: str(fd, 'memberId'), uid: str(fd, 'uid'),
      method: (str(fd, 'method') || undefined) as Method | undefined, idempotencyKey: str(fd, '_key'),
    });
    return `Card ${c.uid} is active.`;
  });
}

export async function blockCardAction(fd: FormData) {
  const ctx = await cashier();
  await act(back(fd, '/staff/counter'), async () => {
    await blockCard(await getDb(), ctx, { cardId: str(fd, 'cardId'), reason: str(fd, 'reason'), kind: (str(fd, 'kind') || 'lost') as 'lost' | 'damaged' });
    return 'Card blocked. It is rejected everywhere from now on. Profile and wallet are untouched.';
  });
}

export async function replaceCardAction(fd: FormData) {
  const ctx = await cashier();
  await act(back(fd, '/staff/counter'), async () => {
    const c = await replaceCard(await getDb(), ctx, {
      outletId: str(fd, 'outletId'), memberId: str(fd, 'memberId'), newUid: str(fd, 'uid'),
      method: (str(fd, 'method') || undefined) as Method | undefined, idempotencyKey: str(fd, '_key'),
    });
    return `Card ${c.uid} is active. The profile, wallet and history carried over.`;
  });
}

export async function openShiftAction(fd: FormData) {
  const ctx = await cashier();
  await act(back(fd, '/staff/shift'), async () => {
    await openShift(await getDb(), ctx, { outletId: str(fd, 'outletId'), openingCash: rupeesToPaise(fd, 'openingCash') });
    return 'Shift opened. You can take payments now.';
  });
}

export async function closeShiftAction(fd: FormData) {
  const ctx = await cashier();
  await act(back(fd, '/staff/shift'), async () => {
    await closeShift(await getDb(), ctx, str(fd, 'shiftId'), {
      counted: { cash: rupeesToPaise(fd, 'cash'), card: rupeesToPaise(fd, 'card'), upi: rupeesToPaise(fd, 'upi') },
      note: str(fd, 'note') || undefined,
    });
    return 'Shift submitted. The owner will review it.';
  });
}

// ---------- dealer ----------
export async function openSessionAction(fd: FormData) {
  const ctx = await dealer();
  await act(back(fd, '/staff/floor'), async () => {
    const s = await openSession(await getDb(), ctx, str(fd, 'tableId'));
    return { to: `/staff/floor?o=${s.outletId}&t=${s.tableId}`, msg: 'Session started. Tap players in to seat them.' };
  });
}

export async function seatPlayerAction(fd: FormData) {
  const ctx = await dealer();
  await act(back(fd, '/staff/floor'), async () => {
    const seat = str(fd, 'seat');
    const r = await seatPlayer(await getDb(), ctx, { sessionId: str(fd, 'sessionId'), uid: str(fd, 'uid'), seatNumber: seat ? Number(seat) : undefined });
    return `${r.memberName} is in seat ${r.seatNumber}.`;
  });
}

export async function leaveSeatAction(fd: FormData) {
  const ctx = await dealer();
  await act(back(fd, '/staff/floor'), async () => {
    await leaveSeat(await getDb(), ctx, { sessionId: str(fd, 'sessionId'), memberId: str(fd, 'memberId') });
    return 'Seat is free.';
  });
}

export async function chipsAction(fd: FormData) {
  const ctx = await dealer();
  await act(back(fd, '/staff/floor'), async () => {
    const kind = str(fd, 'kind');
    const input = { sessionId: str(fd, 'sessionId'), memberId: str(fd, 'memberId'), amount: rupeesToPaise(fd, 'amount'), idempotencyKey: str(fd, '_key') };
    const db = await getDb();
    if (kind === 'issue') {
      const r = await issueChips(db, ctx, input);
      return r.replayed ? 'Those chips were already issued. Nothing was issued twice.' : `Chips issued. Wallet is now ${formatINR(r.balanceAfter ?? 0)}.`;
    }
    const r = await returnChips(db, ctx, input);
    return r.replayed ? 'Those chips were already returned.' : `Chips returned. Wallet is now ${formatINR(r.balanceAfter ?? 0)}.`;
  });
}

export async function createRoundAction(fd: FormData) {
  const ctx = await dealer();
  await act(back(fd, '/staff/floor'), async () => {
    const r = await createRound(await getDb(), ctx, {
      sessionId: str(fd, 'sessionId'), participants: fd.getAll('participants').map(String), winnerMemberId: str(fd, 'winner') || null,
      pot: rupeesToPaise(fd, 'pot'), notes: str(fd, 'notes') || undefined, submit: str(fd, 'submit') === 'yes',
    });
    return r.status === 'submitted' ? `Round ${r.roundNumber} submitted.` : `Round ${r.roundNumber} saved as a draft.`;
  });
}

export async function submitRoundAction(fd: FormData) {
  const ctx = await dealer();
  await act(back(fd, '/staff/floor'), async () => {
    const r = await submitRound(await getDb(), ctx, str(fd, 'roundId'));
    return `Round ${r.roundNumber} submitted. Only the owner can correct it now.`;
  });
}

export async function closeSessionAction(fd: FormData) {
  const ctx = await dealer();
  const o = str(fd, 'outletId');
  await act(back(fd, '/staff/floor'), async () => {
    const s = await closeSession(await getDb(), ctx, str(fd, 'sessionId'), { exceptionNote: str(fd, 'exceptionNote') || undefined });
    return { to: `/staff/floor?o=${o}`, msg: s.exceptionAmount > 0 ? `Session closed with ${formatINR(s.exceptionAmount)} of chips unreturned. The owner has been asked to resolve it.` : 'Session closed. Every chip is accounted for.' };
  });
}

// ---------- waiter ----------
export async function placeOrderAction(fd: FormData) {
  const ctx = await waiter();
  await act(back(fd, '/staff/order'), async () => {
    const items = [...fd.entries()]
      .filter(([k, v]) => k.startsWith('qty_') && Number(v) > 0)
      .map(([k, v]) => ({ menuItemId: k.slice(4), quantity: Number(v) }));
    const uid = str(fd, 'uid');
    const { order, replayed } = await placeOrder(await getDb(), ctx, {
      outletId: str(fd, 'outletId'), uid: uid || undefined, memberId: uid ? undefined : str(fd, 'memberId') || undefined,
      sessionId: str(fd, 'sessionId') || undefined, orderType: str(fd, 'orderType') as 'player' | 'guest',
      guestCount: Number(str(fd, 'guestCount') || 0), items, idempotencyKey: str(fd, '_key'),
    });
    if (replayed) return `Order ${order.orderNo} was already sent.`;
    return `Order ${order.orderNo} sent to the kitchen${order.total ? ` · ${formatINR(order.total)} charged` : ' · ₹0'}.`;
  });
}

// ---------- kitchen ----------
export async function orderStatusAction(fd: FormData) {
  const ctx = await kitchen();
  await act(back(fd, '/kds'), async () => {
    const o = await updateOrderStatus(await getDb(), ctx, str(fd, 'orderId'), str(fd, 'to') as 'preparing' | 'ready' | 'served' | 'cancelled', str(fd, 'reason') || undefined);
    return `${o.orderNo} is ${o.status}.`;
  });
}
