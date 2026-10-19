import { getDb } from '@/db/client';
import { resolveOutlets } from '@/lib/outlet';
import { currentCtx } from '@/lib/session';
import { recentLedger } from '@/server/reports';

export const dynamic = 'force-dynamic';

const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Wallet ledger as CSV for the outlets the owner picked. Amounts are in rupees. */
export async function GET(req: Request) {
  const ctx = await currentCtx();
  if (!ctx || ctx.role !== 'owner') return new Response('Forbidden', { status: 403 });
  const o = new URL(req.url).searchParams.get('o') ?? undefined;
  const scope = await resolveOutlets(ctx, o, { defaultAll: true });
  const db = await getDb();
  const rows = (await Promise.all(scope.ids.map(async (id) => (await recentLedger(db, ctx, id, 5000)).map((r) => ({ ...r, outlet: scope.outlets.find((x) => x.id === id)?.name }))))).flat();
  const head = ['When', 'Outlet', 'Member', 'Member number', 'Type', 'Direction', 'Amount (INR)', 'Balance after (INR)', 'Reference'];
  const lines = rows.map(({ entry, memberName, memberNumber, outlet, reference }) =>
    [entry.createdAt.toISOString(), outlet, memberName, memberNumber, entry.type, entry.direction, entry.amount / 100, entry.balanceAfter / 100, reference].map(cell).join(','),
  );
  return new Response([head.map(cell).join(','), ...lines].join('\n'), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="wallet-ledger.csv"' },
  });
}
