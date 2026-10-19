import { redirect } from 'next/navigation';
import { currentCtx, homeFor } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const ctx = await currentCtx();
  redirect(ctx ? homeFor(ctx.role) : '/login');
}
