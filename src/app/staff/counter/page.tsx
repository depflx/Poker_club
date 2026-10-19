import Link from 'next/link';
import {
  blockCardAction, confirmPaymentAction, createMemberAction, failPaymentAction, issueCardAction, recordPaymentAction, replaceCardAction,
} from '@/app/actions/staff';
import { StaffShell } from '@/app/staff/StaffShell';
import { CardInput } from '@/components/CardInput';
import { FormKeys, Money, Tag, Tier, initials, inr, statusKind, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { getMemberProfile, searchMembers } from '@/server/members';
import { getSettings } from '@/server/outlets';
import { listPayments } from '@/server/payments';
import { currentShift } from '@/server/shifts';
import { listLedger } from '@/server/wallet';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Counter · DepFlx Staff' };

const TYPE_LABEL: Record<string, string> = {
  recharge: 'Recharge', chip_buy_in: 'Chip buy-in', chip_return: 'Chip return', guest_food: 'Guest food', adjustment: 'Adjustment', reversal: 'Reversal',
};

export default async function Counter({ searchParams }: { searchParams: Promise<{ o?: string; q?: string; m?: string; r?: string }> }) {
  const ctx = await requireCtx(['cashier']);
  const { o, q = '', m, r } = await searchParams;
  const db = await getDb();
  return (
    <StaffShell ctx={ctx} current="/staff/counter" title="Counter" eyebrow="Members, cards and money" o={o}>
      {async (scope) => {
        const outlet = scope.one!;
        const list = await searchMembers(db, ctx, { q, outletId: outlet.id, limit: 30 });
        const sel = list.find((x) => x.id === m) ?? (m ? (await searchMembers(db, ctx, { q: '', outletId: outlet.id, limit: 500 })).find((x) => x.id === m) : undefined);
        const shift = await currentShift(db, ctx, outlet.id);
        const settings = await getSettings(db, ctx, outlet.id);
        const pending = (await listPayments(db, ctx, outlet.id, { status: 'pending' }));
        const href = (extra: Record<string, string>) => `/staff/counter?${new URLSearchParams({ o: outlet.id, ...(q ? { q } : {}), ...extra })}`;
        const back = sel ? href({ m: sel.id }) : href({});
        let detail = null;
        if (sel) {
          const profile = await getMemberProfile(db, ctx, sel.id, outlet.id);
          const ledger = await listLedger(db, ctx, sel.id, outlet.id, { limit: 6 });
          const active = profile.cards.find((c) => c.status === 'active');
          const hasHistory = profile.cards.length > 0;
          detail = (
            <div className="grid">
              <section className="card">
                <div className="row sp" style={{ alignItems: 'flex-start' }}>
                  <div className="row" style={{ gap: 16, flexWrap: 'nowrap' }}>
                    <div className="av" style={{ width: 64, height: 64, fontSize: 22 }}>{initials(sel.name)}</div>
                    <div>
                      <div className="mid" style={{ textTransform: 'uppercase' }}>{sel.name}</div>
                      <p className="sub num" style={{ marginTop: 4 }}>{sel.memberNumber} · {sel.mobile}</p>
                      <div className="row" style={{ marginTop: 10 }}><Tier tier={sel.tier} /><span>{sel.tier}</span><Tag kind={statusKind(sel.status)}>{sel.status}</Tag><Tag kind={active ? 'ok' : 'warn'}>{active ? `Card ${active.uid}` : 'No active card'}</Tag></div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="eyebrow">Wallet at {outlet.name}</div>
                    <div className="big" style={{ marginTop: 8 }}>{inr(profile.balance)}</div>
                  </div>
                </div>
              </section>

              <div className="grid cols11">
                <section className="card">
                  <h2>Recharge wallet</h2>
                  <p className="sub">Cash and card credit at once. UPI waits until it is confirmed.</p>
                  <form action={recordPaymentAction}>
                    <FormKeys back={back} />
                    <input type="hidden" name="outletId" value={outlet.id} /><input type="hidden" name="memberId" value={sel.id} />
                    <label htmlFor="amount">Amount</label><Money name="amount" required min={1} />
                    <label htmlFor="method">Paid by</label>
                    <select id="method" name="method" defaultValue="cash"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select>
                    <button className="btn p" style={{ marginTop: 16 }} disabled={!shift}>Take payment</button>
                    {!shift && <p className="sub" style={{ marginTop: 8 }}>Open a shift before taking payments. <Link href={`/staff/shift?o=${outlet.id}`} style={{ textDecoration: 'underline' }}>Open shift</Link></p>}
                  </form>
                  {r && <p className="sub" style={{ marginTop: 12 }}><Link href={`/staff/receipt/${r}?o=${outlet.id}`} style={{ textDecoration: 'underline' }}>View and print the last receipt</Link></p>}
                </section>

                <section className="card">
                  <h2>Card</h2>
                  {!hasHistory && (
                    <>
                      <p className="sub">Issue a card. The {inr(settings.issueFee)} fee is separate from the wallet.</p>
                      <form action={issueCardAction}>
                        <FormKeys back={back} />
                        <input type="hidden" name="outletId" value={outlet.id} /><input type="hidden" name="memberId" value={sel.id} />
                        <CardInput />
                        <label htmlFor="fee-method">Fee paid by</label>
                        <select id="fee-method" name="method" defaultValue="cash"><option value="cash">Cash</option><option value="card">Card</option></select>
                        <button className="btn p" style={{ marginTop: 16 }} disabled={!shift}>Issue card</button>
                      </form>
                    </>
                  )}
                  {active && (
                    <>
                      <p className="sub">Active card <span className="num">{active.uid}</span>. If the member lost it, block it now. Their wallet stays.</p>
                      <details className="pop mt">
                        <summary>Report lost or damaged</summary>
                        <div className="body">
                          <form action={blockCardAction}>
                            <FormKeys back={back} /><input type="hidden" name="cardId" value={active.id} />
                            <label htmlFor="kind">What happened</label>
                            <select id="kind" name="kind"><option value="lost">Lost</option><option value="damaged">Damaged</option></select>
                            <label htmlFor="blk-reason">Reason (required)</label>
                            <input id="blk-reason" name="reason" required placeholder="Where or how?" />
                            <button className="btn d s" style={{ marginTop: 12 }}>Block this card</button>
                          </form>
                        </div>
                      </details>
                    </>
                  )}
                  {hasHistory && !active && (
                    <>
                      <p className="sub">No active card. Replacing keeps the profile, wallet and history. The {inr(settings.replacementFee)} fee is separate from the wallet.</p>
                      <form action={replaceCardAction}>
                        <FormKeys back={back} />
                        <input type="hidden" name="outletId" value={outlet.id} /><input type="hidden" name="memberId" value={sel.id} />
                        <CardInput label="New card ID" />
                        <label htmlFor="rep-method">Fee paid by</label>
                        <select id="rep-method" name="method" defaultValue="cash"><option value="cash">Cash</option><option value="card">Card</option></select>
                        <button className="btn p" style={{ marginTop: 16 }} disabled={!shift}>Replace card</button>
                      </form>
                    </>
                  )}
                  {hasHistory && (
                    <ul className="timeline">
                      {profile.cards.map((c) => (
                        <li key={c.id} className={c.status === 'active' ? '' : c.status === 'lost' || c.status === 'damaged' ? 'bad' : 'warn'}>
                          <b className="num">{c.uid}</b><small>{c.status}{c.reason ? ` · ${c.reason}` : ''}</small>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              <section className="card">
                <h2>Recent wallet activity</h2>
                <div className="scroll mt">
                  <table className="tbl"><tbody>
                    {ledger.map((l) => (
                      <tr key={l.id}>
                        <td><b style={{ fontWeight: 600 }}>{TYPE_LABEL[l.type] ?? l.type}</b><br /><small className="sub">{ts(l.createdAt)}</small></td>
                        <td className={`r num ${l.direction === 'cr' ? 'pos' : 'neg'}`} style={{ textAlign: 'right' }}>{l.direction === 'cr' ? '+' : '−'}{inr(l.amount)}</td>
                        <td className="num" style={{ textAlign: 'right', color: 'var(--mut)' }}>{inr(l.balanceAfter)}</td>
                      </tr>
                    ))}
                    {!ledger.length && <tr><td className="sub" style={{ padding: 16 }}>No wallet activity at this outlet yet.</td></tr>}
                  </tbody></table>
                </div>
              </section>
            </div>
          );
        }
        return (
          <>
            {!shift && (
              <div className="note" style={{ marginTop: 0, marginBottom: 18 }}>
                You have no open shift at {outlet.name}. Payments and card fees need one. <Link href={`/staff/shift?o=${outlet.id}`} style={{ textDecoration: 'underline' }}>Open a shift</Link>
              </div>
            )}
            <div className="split">
              <section className="card list">
                <form action="/staff/counter" method="get">
                  <input type="hidden" name="o" value={outlet.id} />
                  <input name="q" defaultValue={q} placeholder="Name, mobile, member ID or card" aria-label="Search members" autoFocus />
                </form>
                <div role="listbox" aria-label="Members" className="mt">
                  {list.map((x) => (
                    <Link key={x.id} className="it" role="option" aria-selected={x.id === sel?.id} href={href({ m: x.id })}>
                      <div className="av">{initials(x.name)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}><b>{x.name} <Tier tier={x.tier} /></b><small>{x.memberNumber} · {x.activeCardUid ?? 'no card'}</small></div>
                      <span className="num" style={{ fontSize: 13 }}>{inr(x.balance)}</span>
                    </Link>
                  ))}
                  {!list.length && <p className="sub" style={{ padding: 14 }}>No members match. Check the spelling or register them below.</p>}
                </div>
                <details className="pop mt" open={!list.length && !!q}>
                  <summary>Register a new member</summary>
                  <div className="body">
                    <form action={createMemberAction}>
                      <FormKeys back={href({})} /><input type="hidden" name="outletId" value={outlet.id} />
                      <label htmlFor="nm-name">Full name</label><input id="nm-name" name="name" required minLength={2} />
                      <label htmlFor="nm-mob">Mobile (10 digits)</label><input id="nm-mob" name="mobile" required pattern="[0-9]{10}" inputMode="numeric" />
                      <label htmlFor="nm-tier">Membership tier</label>
                      <select id="nm-tier" name="tier" defaultValue="Bronze">{(['Bronze', 'Silver', 'Gold', 'Platinum'] as const).map((t) => <option key={t} value={t}>{t} · {inr(settings.tierFees[t])}</option>)}</select>
                      <button className="btn p" style={{ marginTop: 14 }}>Register member</button>
                    </form>
                  </div>
                </details>
              </section>
              {detail ?? <section className="card"><h2>Pick a member</h2><p className="sub">Search on the left, or register someone new. Their wallet, card and recharge options appear here.</p></section>}
            </div>

            {pending.length > 0 && (
              <section className="card mt">
                <h2>Pending UPI payments</h2>
                <p className="sub">Confirm once you have seen the money arrive. The wallet is credited only then.</p>
                <div className="scroll mt">
                  <table className="tbl"><tbody>
                    {pending.map(({ payment, memberName }) => (
                      <tr key={payment.id}>
                        <td className="num">{payment.receiptNo}<br /><small className="sub">{ts(payment.createdAt)}</small></td>
                        <td>{memberName}</td>
                        <td className="num">{inr(payment.amount)}</td>
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end' }}>
                            <form action={confirmPaymentAction} className="row">
                              <FormKeys back={back} /><input type="hidden" name="paymentId" value={payment.id} />
                              <input name="ref" required placeholder="UPI reference" style={{ width: 150 }} aria-label="UPI reference" />
                              <button className="btn s p">Confirm</button>
                            </form>
                            <details className="pop"><summary>Mark failed</summary>
                              <div className="body"><form action={failPaymentAction}><FormKeys back={back} /><input type="hidden" name="paymentId" value={payment.id} /><label htmlFor={`f-${payment.id}`}>Reason</label><input id={`f-${payment.id}`} name="reason" required /><button className="btn s d" style={{ marginTop: 12 }}>Mark failed</button></form></div>
                            </details>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody></table>
                </div>
              </section>
            )}
          </>
        );
      }}
    </StaffShell>
  );
}
