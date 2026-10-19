import Link from 'next/link';
import { approveShiftAction, ownerConfirmPaymentAction, ownerFailPaymentAction, rejectShiftAction, reverseEntryAction } from '@/app/actions/owner';
import { OwnerShell } from '@/app/owner/OwnerShell';
import { FormKeys, Tag, inr, statusKind, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listPayments } from '@/server/payments';
import { outletBooks, recentLedger } from '@/server/reports';
import { listShifts } from '@/server/shifts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Books · DepFlx Owner' };

const TYPE_LABEL: Record<string, string> = {
  recharge: 'Recharge', chip_buy_in: 'Chip buy-in', chip_return: 'Chip return', guest_food: 'Guest food', adjustment: 'Adjustment', reversal: 'Reversal',
};

export default async function Books({ searchParams }: { searchParams: Promise<{ o?: string }> }) {
  const ctx = await requireCtx(['owner']);
  const { o } = await searchParams;
  const db = await getDb();
  return (
    <OwnerShell ctx={ctx} current="/owner/books" title="The books" eyebrow="Money in, money held" o={o} defaultAll>
      {async (scope) => {
        const back = `/owner/books?o=${scope.selected}`;
        const name = (id: string) => scope.outlets.find((x) => x.id === id)?.name ?? '';
        const shifts = (await Promise.all(scope.ids.map((id) => listShifts(db, ctx, id)))).flat();
        const awaiting = shifts.filter((s) => s.shift.status === 'review');
        const recent = shifts.filter((s) => s.shift.status === 'approved').slice(0, 4);
        const pending = (await Promise.all(scope.ids.map((id) => listPayments(db, ctx, id, { status: 'pending' })))).flat();
        const books = await Promise.all(scope.ids.map((id) => outletBooks(db, ctx, id)));
        const ledger = (await Promise.all(scope.ids.map((id) => recentLedger(db, ctx, id, 12)))).flat()
          .sort((a, b) => b.entry.createdAt.getTime() - a.entry.createdAt.getTime()).slice(0, 14);
        const sum = (f: (b: (typeof books)[number]) => number) => books.reduce((a, b) => a + f(b), 0);
        const purposes = [
          ['Wallet recharge', sum((b) => b.collected.recharge)], ['Card issuance fees', sum((b) => b.collected.cardIssue)], ['Card replacement fees', sum((b) => b.collected.cardReplacement)],
        ] as const;
        return (
          <>
            <div className="grid cols2">
              <section className="card">
                <h2>Shifts to review</h2>
                <p className="sub">Counted figures are never altered to force a match.</p>
                {!awaiting.length && <p className="sub mt">No shift is waiting for you.</p>}
                {awaiting.map(({ shift, cashier }) => {
                  const exp = shift.expected ?? { cash: 0, card: 0, upi: 0 };
                  const cnt = shift.counted ?? { cash: 0, card: 0, upi: 0 };
                  return (
                    <div key={shift.id} className="mt">
                      <div className="row sp">
                        <b>{cashier} · {name(shift.outletId)}</b>
                        <Tag kind="warn">Awaiting your approval</Tag>
                      </div>
                      <div className="shiftcmp">
                        {(['cash', 'card', 'upi'] as const).map((k) => {
                          const d = (cnt[k] ?? 0) - (exp[k] ?? 0);
                          return (
                            <div className="cmp" key={k}>
                              <div className="eyebrow">{k}</div>
                              <div className="l"><span>Expected</span><span className="num" style={{ color: 'var(--ink)' }}>{inr(exp[k] ?? 0)}</span></div>
                              <div className="l"><span>Counted</span><span className="num" style={{ color: 'var(--ink)' }}>{inr(cnt[k] ?? 0)}</span></div>
                              <div className={`diff ${d ? 'neg' : 'pos'}`}>{d ? `${d < 0 ? 'Short' : 'Over'} ${inr(Math.abs(d))}` : 'Matches'}</div>
                            </div>
                          );
                        })}
                      </div>
                      {shift.note && <div className="note" style={{ marginTop: 0 }}><b style={{ color: 'var(--ink)' }}>Cashier’s note.</b> {shift.note}</div>}
                      <div className="row mt">
                        <form action={approveShiftAction} className="row">
                          <FormKeys back={back} />
                          <input type="hidden" name="shiftId" value={shift.id} />
                          <input name="note" placeholder="Note (optional)" style={{ width: 200 }} aria-label="Approval note" />
                          <button className="btn p">Approve and lock shift</button>
                        </form>
                        <details className="pop">
                          <summary>Send back to cashier</summary>
                          <div className="body">
                            <form action={rejectShiftAction}>
                              <FormKeys back={back} />
                              <input type="hidden" name="shiftId" value={shift.id} />
                              <label htmlFor={`rj-${shift.id}`}>What should be rechecked?</label>
                              <input id={`rj-${shift.id}`} name="reason" required />
                              <button className="btn s d" style={{ marginTop: 12 }}>Send back</button>
                            </form>
                          </div>
                        </details>
                      </div>
                    </div>
                  );
                })}
                {recent.length > 0 && (
                  <>
                    <div className="grp mt">Recently approved</div>
                    {recent.map(({ shift, cashier }) => (
                      <div className="bk" key={shift.id} style={{ gridTemplateColumns: '1fr auto' }}>
                        <div><b style={{ fontWeight: 500 }}>{cashier} · {name(shift.outletId)}</b><p>{ts(shift.openedAt)}</p></div>
                        <span className={`num ${shift.discrepancy ? 'neg' : 'pos'}`} style={{ fontSize: 15 }}>{shift.discrepancy ? `${shift.discrepancy < 0 ? '−' : '+'}${inr(Math.abs(shift.discrepancy))}` : 'Matched'}</span>
                      </div>
                    ))}
                  </>
                )}
              </section>

              <section className="card">
                <h2>Collections</h2>
                <p className="sub">Confirmed payments by purpose. Fees never reach a wallet.</p>
                <div className="mt">
                  {purposes.map(([k, v]) => <div className="bk" key={k} style={{ gridTemplateColumns: '1fr auto' }}><b style={{ fontWeight: 500 }}>{k}</b><span className="num">{inr(v)}</span></div>)}
                  <div className="bk" style={{ gridTemplateColumns: '1fr auto' }}><b>Total confirmed</b><span className="num">{inr(sum((b) => b.collected.total))}</span></div>
                </div>
                <div className="note">Pending UPI of {inr(sum((b) => b.awaitingConfirmation))} is left out until it is confirmed.</div>
              </section>
            </div>

            <section className="card mt">
              <h2>Pending payments</h2>
              <p className="sub">UPI payments the cashier recorded but nobody has confirmed. The wallet is not credited until you do.</p>
              <div className="scroll mt">
                <table className="tbl">
                  <thead><tr><th>Receipt</th><th>Member</th><th>Purpose</th><th className="r">Amount</th><th></th></tr></thead>
                  <tbody>
                    {pending.map(({ payment, memberName }) => (
                      <tr key={payment.id}>
                        <td className="num">{payment.receiptNo}<br /><small className="sub">{name(payment.outletId)} · {ts(payment.createdAt)}</small></td>
                        <td>{memberName}</td>
                        <td>{payment.purpose.replace('_', ' ')}</td>
                        <td className="r num">{inr(payment.amount)}</td>
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end' }}>
                            <form action={ownerConfirmPaymentAction} className="row">
                              <FormKeys back={back} />
                              <input type="hidden" name="paymentId" value={payment.id} />
                              <input name="ref" required placeholder="UPI reference" style={{ width: 150 }} aria-label="UPI reference" />
                              <button className="btn s p">Confirm</button>
                            </form>
                            <details className="pop">
                              <summary>Mark failed</summary>
                              <div className="body">
                                <form action={ownerFailPaymentAction}>
                                  <FormKeys back={back} />
                                  <input type="hidden" name="paymentId" value={payment.id} />
                                  <label htmlFor={`f-${payment.id}`}>Reason</label>
                                  <input id={`f-${payment.id}`} name="reason" required />
                                  <button className="btn s d" style={{ marginTop: 12 }}>Mark failed</button>
                                </form>
                              </div>
                            </details>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!pending.length && <tr><td colSpan={5} className="sub" style={{ padding: 20 }}>Nothing is pending.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card mt">
              <div className="row sp">
                <div><h2>Wallet ledger</h2><p className="sub">Latest postings. Entries are never edited. A mistake gets a reversal.</p></div>
                <Link className="btn" href={`/owner/books/export?o=${scope.selected}`}>Export CSV</Link>
              </div>
              <div className="scroll mt">
                <table className="tbl">
                  <thead><tr><th>When</th><th>Member</th><th>Type</th><th>Reference</th><th className="r">Amount</th><th></th></tr></thead>
                  <tbody>
                    {ledger.map(({ entry, memberName, memberNumber, reference }) => (
                      <tr key={entry.id}>
                        <td className="num" style={{ fontSize: 13 }}>{ts(entry.createdAt)}</td>
                        <td>{memberName} <small className="num sub">{memberNumber}</small></td>
                        <td>{TYPE_LABEL[entry.type] ?? entry.type}{scope.isAll ? <><br /><small className="sub">{name(entry.outletId)}</small></> : null}</td>
                        <td style={{ color: 'var(--mut)' }}>{reference}</td>
                        <td className={`r num ${entry.direction === 'cr' ? 'pos' : 'neg'}`}>{entry.direction === 'cr' ? '+' : '−'}{inr(entry.amount)}</td>
                        <td>
                          {entry.type !== 'reversal' && (
                            <details className="pop">
                              <summary>Reverse</summary>
                              <div className="body">
                                <form action={reverseEntryAction}>
                                  <FormKeys back={back} />
                                  <input type="hidden" name="ledgerId" value={entry.id} />
                                  <label htmlFor={`rv-${entry.id}`}>Reason</label>
                                  <input id={`rv-${entry.id}`} name="reason" required />
                                  <button className="btn s d" style={{ marginTop: 12 }}>Post reversal</button>
                                </form>
                              </div>
                            </details>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!ledger.length && <tr><td colSpan={6} className="sub" style={{ padding: 20 }}>No wallet activity yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <p className="sub mt"><Tag kind={statusKind('active')}>Append-only</Tag> The ledger, audit trail and chip log cannot be edited or deleted, even by the database user the app runs as.</p>
          </>
        );
      }}
    </OwnerShell>
  );
}
