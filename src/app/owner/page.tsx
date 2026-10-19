import Link from 'next/link';
import { OwnerShell } from '@/app/owner/OwnerShell';
import { MiniTable } from '@/components/Pit';
import { inr } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { cardCounts, decisionQueue, floorOverview, outletBooks, ownerRollup, type Books } from '@/server/reports';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tonight · DepFlx Owner' };

const DAY = () => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return { from };
};

export default async function Tonight({ searchParams }: { searchParams: Promise<{ o?: string }> }) {
  const ctx = await requireCtx(['owner']);
  const { o } = await searchParams;
  const db = await getDb();
  return (
    <OwnerShell ctx={ctx} current="/owner" title="Tonight" eyebrow={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} o={o} defaultAll>
      {async (scope) => {
        const range = DAY();
        const floor = (await Promise.all(scope.ids.map((id) => floorOverview(db, ctx, id)))).flat();
        const queue = await decisionQueue(db, ctx, scope.isAll ? undefined : scope.selected);
        const cards = await cardCounts(db, ctx);
        let b: Books;
        let perOutlet: { id: string; name: string; books: Books }[] = [];
        if (scope.isAll) {
          const roll = await ownerRollup(db, ctx, range);
          perOutlet = roll.perOutlet.map((p) => ({ id: p.outlet.id, name: p.outlet.name, books: p.books }));
          const sum = (f: (x: Books) => number) => roll.perOutlet.reduce((a, p) => a + f(p.books), 0);
          b = {
            outletId: 'all', revenue: null,
            collected: {
              total: sum((x) => x.collected.total), cash: sum((x) => x.collected.cash), upi: sum((x) => x.collected.upi), card: sum((x) => x.collected.card),
              recharge: sum((x) => x.collected.recharge), cardIssue: sum((x) => x.collected.cardIssue), cardReplacement: sum((x) => x.collected.cardReplacement),
            },
            awaitingConfirmation: roll.totals.awaitingConfirmation, feesCollected: roll.totals.feesCollected, guestFoodCharged: roll.totals.guestFoodCharged,
            walletLiability: roll.totals.walletLiability, chipsOutstanding: roll.totals.chipsOutstanding,
          };
        } else {
          b = await outletBooks(db, ctx, scope.selected, range);
        }
        const seated = floor.reduce((a, t) => a + t.seats.length, 0);
        const live = floor.filter((t) => t.inPlay).length;
        const full = floor.filter((t) => t.inPlay && t.seats.length >= t.maxSeats);
        const methods = [
          { k: 'Cash', v: b.collected.cash, c: '#14181B' }, { k: 'UPI', v: b.collected.upi, c: '#2F5FC4' }, { k: 'Card', v: b.collected.card, c: '#B8872E' },
        ];
        const outletName = (id: string) => scope.outlets.find((x) => x.id === id)?.name ?? '';
        const suffix = scope.isAll ? '?o=all' : `?o=${scope.selected}`;
        return (
          <>
            <section className="card hero" data-surface="floor" aria-label="Live floor">
              <div>
                <div className="eyebrow">On the floor now</div>
                <div className="big" style={{ margin: '12px 0 6px' }}>{seated}</div>
                <p style={{ fontSize: 16 }}>players seated across {live} table{live === 1 ? '' : 's'}</p>
                <p className="sub" style={{ marginTop: 8 }}>
                  {full.length ? `${full.map((t) => t.name).join(', ')} ${full.length === 1 ? 'is' : 'are'} full. ` : 'No table is full. '}
                  Chips out: <span className="num">{inr(b.chipsOutstanding)}</span>
                </p>
              </div>
              <div className="minis">
                {floor.slice(0, 8).map((t) => (
                  <Link key={t.tableId} href={`/owner/floor?o=${t.outletId}&t=${t.tableId}`} className={`mini ${t.inPlay ? '' : 'idle'}`} aria-label={`${t.name}, ${t.seats.length} of ${t.maxSeats} seated`}>
                    <MiniTable seats={t.seats} maxSeats={t.maxSeats} />
                    <b>{t.name}</b>
                    <span>{t.inPlay ? `${t.seats.length} / ${t.maxSeats} seated` : 'Not in play'}{scope.isAll ? ` · ${outletName(t.outletId)}` : ''}</span>
                  </Link>
                ))}
                {!floor.length && <p className="sub">No tables yet. Add them under Settings.</p>}
              </div>
            </section>

            <div className="grid cols2 mt">
              <section className="card" aria-labelledby="bk">
                <h2 id="bk">The books</h2>
                <p className="sub" style={{ marginBottom: 6 }}>Every figure is kept separate. Nothing here is called revenue.</p>
                <div className="grp">Today</div>
                <Row c="#14181B" t="Collected at the counter" v={inr(b.collected.total)} d="Cash, UPI and card actually received and confirmed. Not revenue." />
                <Row c="#2F5FC4" t="Awaiting confirmation" v={inr(b.awaitingConfirmation)} d="UPI attempts not yet confirmed. The wallet is not credited until they are." />
                <Row c="#B8872E" t="Card fees collected" v={inr(b.feesCollected)} d="Card issuance and replacement fees. Never credited to a wallet." />
                <Row c="#C4412F" t="Guest food charged" v={inr(b.guestFoodCharged)} d="Chargeable guest meals only. Player food is always ₹0." />
                <div className="grp">Standing</div>
                <Row c="#2E6A57" t="Wallet liability" v={inr(b.walletLiability)} d="What the club owes members in unspent wallet balance." />
                <Row c="#5C656A" t="Chips on the tables" v={inr(b.chipsOutstanding)} d="Physical chips issued and not yet returned in running sessions." />
                <div className="bk">
                  <div><b>Revenue</b></div><span className="num" style={{ color: 'var(--mut)' }}>Not defined</span>
                  <p>Decide how the club counts revenue before this figure is shown.</p>
                </div>
              </section>

              <section className="card" aria-labelledby="dc">
                <h2 id="dc">Needs your decision</h2>
                <p className="sub">{queue.shifts.length + queue.pendingPayments.length + queue.chipExceptions.length} open</p>
                <div className="mt">
                  {queue.shifts.map((s) => (
                    <Decision key={s.shift.id} kind="warn" t="A shift is waiting for your approval" d={`${s.cashier} counted ${s.shift.discrepancy ? `${inr(Math.abs(s.shift.discrepancy ?? 0))} ${(s.shift.discrepancy ?? 0) < 0 ? 'short' : 'over'}` : 'an exact match'}. Review and lock it.`} href={`/owner/books?o=${s.shift.outletId}`} cta="Review shift" />
                  ))}
                  {queue.pendingPayments.map((p) => (
                    <Decision key={p.payment.id} kind="info" t={`${inr(p.payment.amount)} ${p.payment.method.toUpperCase()} is still pending`} d={`${p.memberName}. The wallet is not credited until you confirm it.`} href={`/owner/books?o=${p.payment.outletId}`} cta="See payment" />
                  ))}
                  {queue.chipExceptions.map((s) => (
                    <Decision key={s.id} kind="bad" t={`${inr(s.exceptionAmount)} of chips left a table unreturned`} d={s.exceptionNote ?? ''} href={`/owner/floor?o=${s.outletId}`} cta="Open floor" />
                  ))}
                  {!queue.shifts.length && !queue.pendingPayments.length && !queue.chipExceptions.length && <p className="sub">Nothing needs you right now.</p>}
                </div>
              </section>
            </div>

            <div className="grid cols2 mt">
              <section className="card">
                <h2>Collections by method</h2>
                <p className="sub">Confirmed today. Pending UPI is excluded.</p>
                <div className="bar" role="img" aria-label="Collections by method">
                  {methods.filter((m) => m.v > 0).map((m) => <div key={m.k} style={{ flex: m.v, background: m.c }} />)}
                  {b.collected.total === 0 && <div style={{ flex: 1, background: 'var(--line)' }} />}
                </div>
                <div className="legend">
                  {methods.map((m) => <span key={m.k}><i className="sw" style={{ background: m.c }} />{m.k} <span className="num" style={{ color: 'var(--ink)' }}>{inr(m.v)}</span></span>)}
                </div>
              </section>
              <section className="card">
                <h2>Cards</h2>
                <p className="sub">Across all your outlets.</p>
                <div className="kpis mt">
                  <div><div className="eyebrow">Active</div><div className="mid">{cards.active ?? 0}</div></div>
                  <div><div className="eyebrow">Blocked or lost</div><div className="mid">{(cards.lost ?? 0) + (cards.damaged ?? 0)}</div></div>
                  <div><div className="eyebrow">Replaced</div><div className="mid">{cards.replaced ?? 0}</div></div>
                </div>
              </section>
            </div>

            {scope.isAll && perOutlet.length > 1 && (
              <section className="card mt" aria-labelledby="by-outlet">
                <h2 id="by-outlet">By outlet</h2>
                <p className="sub">Each outlet keeps its own wallets and its own books. They are only added together here.</p>
                <div className="scroll mt">
                  <table className="tbl">
                    <thead><tr><th>Outlet</th><th className="r">Collected today</th><th className="r">Awaiting</th><th className="r">Wallet liability</th><th className="r">Chips out</th><th></th></tr></thead>
                    <tbody>
                      {perOutlet.map((p) => (
                        <tr key={p.name}>
                          <td><b style={{ fontWeight: 600 }}>{p.name}</b></td>
                          <td className="r num">{inr(p.books.collected.total)}</td>
                          <td className="r num">{inr(p.books.awaitingConfirmation)}</td>
                          <td className="r num">{inr(p.books.walletLiability)}</td>
                          <td className="r num">{inr(p.books.chipsOutstanding)}</td>
                          <td className="r"><Link className="btn s" href={`/owner?o=${p.id}`}>Open</Link></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <p className="sub mt">Showing {scope.isAll ? 'all outlets' : scope.one?.name}. <Link href={`/owner/books${suffix}`} style={{ textDecoration: 'underline' }}>Open the books</Link></p>
          </>
        );
      }}
    </OwnerShell>
  );
}

function Row({ c, t, v, d }: { c: string; t: string; v: string; d: string }) {
  return (
    <div className="bk">
      <div><b><i className="sw" style={{ background: c }} />{t}</b></div>
      <span className="num">{v}</span>
      <p>{d}</p>
    </div>
  );
}

function Decision({ kind, t, d, href, cta }: { kind: 'warn' | 'info' | 'bad'; t: string; d: string; href: string; cta: string }) {
  return (
    <div className="dec">
      <i className={kind === 'warn' ? '' : kind} />
      <div><b>{t}</b><p>{d}</p></div>
      <Link className="btn s" href={href}>{cta}</Link>
    </div>
  );
}
