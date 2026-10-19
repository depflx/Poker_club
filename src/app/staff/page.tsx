import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function StaffHome() {
  const ctx = await requireCtx(['cashier', 'dealer', 'waiter']);
  redirect({ cashier: '/staff/counter', dealer: '/staff/floor', waiter: '/staff/order' }[ctx.role as 'cashier' | 'dealer' | 'waiter']);
}
