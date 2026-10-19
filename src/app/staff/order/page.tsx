import Link from 'next/link';
import { placeOrderAction } from '@/app/actions/staff';
import { StaffShell } from '@/app/staff/StaffShell';
import { CardInput } from '@/components/CardInput';
import { FormKeys, Tag, initials, inr, statusKind, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listMenu, orderHistory } from '@/server/food';
import { searchMembers } from '@/server/members';
import { getSettings } from '@/server/outlets';
import { tablesBoard } from '@/server/poker';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Food order · DepFlx Staff' };

export default async function WaiterOrder({ searchParams }: { searchParams: Promise<{ o?: string; q?: string; type?: string }> }) {
  const ctx = await requireCtx(['waiter']);
  const { o, q = '', type = 'player' } = await searchParams;
  const db = await getDb();
  return (
    <StaffShell ctx={ctx} current="/staff/order" title="Food order" eyebrow="Player or guest" o={o}>
      {async (scope) => {
        const outlet = scope.one!;
        const guest = type === 'guest';
        const [menu, settings, boards, history] = await Promise.all([
          listMenu(db, ctx, outlet.id), getSettings(db, ctx, outlet.id), tablesBoard(db, ctx, outlet.id), orderHistory(db, ctx, outlet.id, 8),
        ]);
        const found = q ? await searchMembers(db, ctx, { q, outletId: outlet.id, limit: 6 }) : [];
        const chargeable = guest && settings.guestMode === 'chargeable';
        const live = boards.filter((b) => b.session);
        const here = (t: string) => `/staff/order?${new URLSearchParams({ o: outlet.id, ...(q ? { q } : {}), type: t })}`;
        const back = here(type);
        return (
          <div className="grid cols2">
            <form action={placeOrderAction} className="card">
              <FormKeys back={back} /><input type="hidden" name="outletId" value={outlet.id} />
              <h2>1. Who is it for</h2>
              <div className="row" style={{ margin: '8px 0 4px' }}>
                <Link className={`btn ${!guest ? 'p' : ''}`} href={here('player')}>Player order</Link>
                <Link className={`btn ${guest ? 'p' : ''}`} href={here('guest')}>Guest order</Link>
              </div>
              <input type="hidden" name="orderType" value={guest ? 'guest' : 'player'} />
              <CardInput required={false} label="Player card" />
              {found.length > 0 && (
                <>
                  <label>Or pick the member</label>
                  {found.map((m, i) => (
                    <label key={m.id} style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit', fontSize: 14, color: 'var(--ink)', display: 'flex', gap: 10, alignItems: 'center', margin: '6px 0' }}>
                      <input type="radio" name="memberId" value={m.id} defaultChecked={i === 0} style={{ width: 'auto', minHeight: 0 }} />
                      <span className="av" style={{ width: 28, height: 28, fontSize: 11 }}>{initials(m.name)}</span>{m.name} <small className="sub num">{m.memberNumber}</small>
                    </label>
                  ))}
                </>
              )}
              <label htmlFor="session">Table</label>
              <select id="session" name="sessionId" defaultValue=""><option value="">Use the table the player is seated at</option>{live.map((b) => <option key={b.session!.id} value={b.session!.id}>{b.table.name} · {b.players.length} seated</option>)}</select>
              {guest && (<><label htmlFor="gc">How many guests</label><input id="gc" name="guestCount" type="number" min={1} max={20} defaultValue={1} required /></>)}
              <div className="note">
                {!guest ? 'Player food is always free (₹0). This cannot be changed.' : chargeable
                  ? `Guest food is charged. ${settings.guestPayer === 'player' ? 'It comes out of the player’s wallet as a guest-food charge.' : 'It is settled separately at the counter.'}`
                  : 'Guest food is free here, but it is still recorded as a guest order.'}
              </div>

              <h2 style={{ marginTop: 24 }}>2. Items</h2>
              <div>
                {menu.map((i) => (
                  <div className="menu-row" key={i.id}>
                    <div><b style={{ fontWeight: 600 }}>{i.name}</b><br /><small className="sub">{i.category} · {chargeable ? inr(i.guestPrice) : '₹0'}</small></div>
                    <input name={`qty_${i.id}`} type="number" min={0} max={20} defaultValue={0} aria-label={`${i.name} quantity`} />
                  </div>
                ))}
                {!menu.length && <p className="sub">No items are available. Ask the owner to add the menu.</p>}
              </div>
              <button className="btn p" style={{ marginTop: 18, width: '100%', minHeight: 52, fontSize: 16 }}>Send to kitchen</button>
            </form>

            <div className="grid" style={{ alignContent: 'start' }}>
              <section className="card">
                <h2>Find a member</h2>
                <form action="/staff/order" method="get">
                  <input type="hidden" name="o" value={outlet.id} /><input type="hidden" name="type" value={type} />
                  <input name="q" defaultValue={q} placeholder="Name, mobile or member ID" aria-label="Find a member" />
                  <button className="btn s" style={{ marginTop: 10 }}>Search</button>
                </form>
              </section>
              <section className="card">
                <h2>Recent orders</h2>
                <div className="mt">
                  {history.map(({ order, memberName }) => (
                    <div className="bk" key={order.id} style={{ gridTemplateColumns: '1fr auto' }}>
                      <div><b style={{ fontWeight: 600 }}>{order.orderNo}</b> <Tag>{order.orderType}</Tag><p>{memberName} · {ts(order.createdAt)}</p></div>
                      <Tag kind={statusKind(order.status)}>{order.status}</Tag>
                    </div>
                  ))}
                  {!history.length && <p className="sub">No orders yet.</p>}
                </div>
              </section>
            </div>
          </div>
        );
      }}
    </StaffShell>
  );
}
