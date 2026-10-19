import Link from 'next/link';
import { PrintButton } from '@/components/PrintButton';
import { inr, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { getReceipt } from '@/server/payments';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Receipt · DepFlx Staff' };

const PURPOSE: Record<string, string> = { recharge: 'Wallet recharge', card_issue: 'Card issuance fee', card_replacement: 'Replacement card fee' };

export default async function Receipt({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ o?: string }> }) {
  const ctx = await requireCtx(['cashier', 'owner']);
  const { id } = await params;
  const { o } = await searchParams;
  const r = await getReceipt(await getDb(), ctx, id);
  const back = ctx.role === 'owner' ? '/owner/books' : `/staff/counter${o ? `?o=${o}` : ''}`;
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: 24, display: 'grid', placeItems: 'center' }}>
      <div>
        <div className="recpt">
          <div><b>DEPFLX POKER CLUB</b></div>
          <div><span>{r.outlet}</span></div>
          <hr />
          <div><span>Receipt</span><span>{r.receiptNo}</span></div>
          <div><span>Member</span><span>{r.memberNumber}</span></div>
          <div><span>Name</span><span>{r.memberName}</span></div>
          <div><span>Purpose</span><span>{PURPOSE[r.purpose] ?? r.purpose}</span></div>
          <div><span>Method</span><span>{r.method.toUpperCase()}</span></div>
          <div><span>Status</span><span>{r.status.toUpperCase()}</span></div>
          <hr />
          <div><b>Amount</b><b>{inr(r.amount)}</b></div>
          <hr />
          <div><span>Cashier</span><span>{r.cashier}</span></div>
          <div><span>Date</span><span>{ts(r.at)}</span></div>
        </div>
        <div className="row mt">
          <PrintButton />
          <Link className="btn" href={back}>Back</Link>
        </div>
      </div>
    </div>
  );
}
