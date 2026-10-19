import { logoutAction } from '@/app/actions/auth';
import { orderStatusAction } from '@/app/actions/staff';
import { AutoRefresh } from '@/components/AutoRefresh';
import { FormKeys, Tag } from '@/components/ui';
import { getDb } from '@/db/client';
import { resolveOutlets } from '@/lib/outlet';
import { requireCtx } from '@/lib/session';
import { kdsBoard } from '@/server/food';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Kitchen · DepFlx' };

const COLS = [
  { status: 'pending', title: 'New' },
  { status: 'preparing', title: 'Preparing' },
  { status: 'ready', title: 'Ready to serve' },
] as const;

export default async function Kitchen({ searchParams }: { searchParams: Promise<{ o?: string }> }) {
  const ctx = await requireCtx(['kds']);
  const { o } = await searchParams;
  const scope = await resolveOutlets(ctx, o);
  const outlet = scope.one;
  const board = outlet ? await kdsBoard(await getDb(), ctx, outlet.id) : [];
  const back = `/kds?o=${outlet?.id ?? ''}`;
  const served = board.filter((b) => b.status === 'served');
  return (
    <div className="kds">
      <AutoRefresh seconds={5} />
      <div className="kds-top">
        <div>
          <div className="eyebrow">Kitchen · refreshes by itself</div>
          <h1>{outlet?.name ?? 'No outlet'}</h1>
        </div>
        <div className="row">
          {scope.outlets.length > 1 && scope.outlets.map((x) => (
            <a key={x.id} className="btn s" href={`/kds?o=${x.id}`} style={{ background: x.id === outlet?.id ? 'var(--brass)' : undefined, color: x.id === outlet?.id ? '#14181B' : undefined }}>{x.name}</a>
          ))}
          <span className="live" style={{ background: '#171D24', borderColor: '#2A333C' }}><i />{ctx.name}</span>
          <form action={logoutAction}><button className="btn s" style={{ background: '#171D24', borderColor: '#2A333C', color: '#ECEAE2' }}>Sign out</button></form>
        </div>
      </div>
      <div className="kds-cols">
        {COLS.map((c) => {
          const orders = board.filter((b) => b.status === c.status);
          return (
            <section key={c.status} className="kds-col" aria-label={c.title}>
              <h2>{c.title}<span>{orders.length}</span></h2>
              {orders.map((b) => (
                <article key={b.id} className={`kds-card ${b.waitingMinutes >= 10 && c.status !== 'ready' ? 'old' : ''}`}>
                  <div className="row sp">
                    <span className="no">{b.orderNo.split('-').pop()}</span>
                    <span>{b.orderType === 'guest' ? <Tag kind="warn">Guest × {b.guestCount}</Tag> : <Tag kind="ok">Player</Tag>}</span>
                  </div>
                  <div className="where">{b.table ?? 'No table'}{b.seat ? ` · seat ${b.seat}` : ''} · {b.waitingMinutes} min</div>
                  <ul>{b.items.map((i, k) => <li key={k}><b>{i.quantity}×</b>{i.name}</li>)}</ul>
                  <div className="row">
                    {c.status === 'pending' && <Move id={b.id} to="preparing" label="Accept and start" back={back} primary />}
                    {c.status === 'preparing' && (<><Move id={b.id} to="ready" label="Mark ready" back={back} primary /><Move id={b.id} to="served" label="Served" back={back} /></>)}
                    {c.status === 'ready' && <Move id={b.id} to="served" label="Mark served" back={back} primary />}
                  </div>
                  {c.status === 'pending' && (
                    <details className="pop" style={{ marginTop: 10, background: '#0F1318', borderColor: '#2A333C' }}>
                      <summary>Cancel this order</summary>
                      <div className="body">
                        <form action={orderStatusAction}>
                          <FormKeys back={back} /><input type="hidden" name="orderId" value={b.id} /><input type="hidden" name="to" value="cancelled" />
                          <label htmlFor={`c-${b.id}`}>Reason</label>
                          <input id={`c-${b.id}`} name="reason" required style={{ background: '#171D24', borderColor: '#2A333C' }} />
                          <button className="btn s d" style={{ marginTop: 10 }}>Cancel order</button>
                        </form>
                      </div>
                    </details>
                  )}
                </article>
              ))}
              {!orders.length && <p className="kds-empty">Nothing here.</p>}
            </section>
          );
        })}
      </div>
      {served.length > 0 && <p className="kds-empty" style={{ marginTop: 18 }}>Served in the last 30 minutes: {served.map((s) => s.orderNo.split('-').pop()).join(', ')}</p>}
    </div>
  );
}

function Move({ id, to, label, back, primary }: { id: string; to: string; label: string; back: string; primary?: boolean }) {
  return (
    <form action={orderStatusAction} style={{ flex: 1, display: 'flex' }}>
      <FormKeys back={back} /><input type="hidden" name="orderId" value={id} /><input type="hidden" name="to" value={to} />
      <button className={`btn ${primary ? 'p' : ''}`} style={{ flex: 1 }}>{label}</button>
    </form>
  );
}
