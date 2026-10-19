import Link from 'next/link';
import { adjustWalletAction, setMemberStatusAction } from '@/app/actions/owner';
import { OwnerShell } from '@/app/owner/OwnerShell';
import { FormKeys, Money, Tag, Tier, initials, inr, statusKind, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { getMemberProfile, searchMembers } from '@/server/members';
import { listLedger } from '@/server/wallet';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Members · DepFlx Owner' };

const FILTERS = ['All', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Suspended'];
const TYPE_LABEL: Record<string, string> = {
  recharge: 'Recharge', chip_buy_in: 'Chip buy-in', chip_return: 'Chip return', guest_food: 'Guest food', adjustment: 'Adjustment', reversal: 'Reversal',
};

export default async function OwnerMembers({ searchParams }: { searchParams: Promise<{ o?: string; q?: string; f?: string; m?: string }> }) {
  const ctx = await requireCtx(['owner']);
  const { o, q = '', f = 'All', m } = await searchParams;
  const db = await getDb();
  return (
    <OwnerShell ctx={ctx} current="/owner/members" title="Members" eyebrow="Owner-wide · one profile, one wallet per outlet" o={o} defaultAll>
      {async (scope) => {
        const list = await searchMembers(db, ctx, {
          q, outletId: scope.isAll ? undefined : scope.selected,
          status: f === 'Suspended' ? 'suspended' : undefined, tier: ['Bronze', 'Silver', 'Gold', 'Platinum'].includes(f) ? f : undefined,
        });
        const sel = list.find((x) => x.id === m) ?? list[0];
        const href = (extra: Record<string, string>) => {
          const p = new URLSearchParams({ o: scope.selected, ...(q ? { q } : {}), ...(f !== 'All' ? { f } : {}), ...extra });
          return `/owner/members?${p.toString()}`;
        };
        const back = sel ? href({ m: sel.id }) : '/owner/members';
        let detail = null;
        if (sel && scope.one) {
          const profile = await getMemberProfile(db, ctx, sel.id, scope.one.id);
          const ledger = await listLedger(db, ctx, sel.id, scope.one.id, { limit: 8 });
          const events: { at: Date; k: string; b: string; s: string }[] = [];
          for (const c of profile.cards) {
            if (c.issuedAt) events.push({ at: c.issuedAt, k: '', b: 'Card issued', s: c.uid });
            if (c.blockedAt) {
              events.push({ at: c.blockedAt, k: 'bad', b: `Card ${c.status === 'damaged' ? 'reported damaged' : 'reported lost'}, blocked`, s: `${c.uid}${c.reason ? ` · “${c.reason}”` : ''}` });
            }
            if (c.status === 'replaced' && c.replacedByCardId) {
              const next = profile.cards.find((x) => x.id === c.replacedByCardId)?.uid ?? 'a new card';
              events.push({ at: c.blockedAt ?? c.createdAt, k: 'warn', b: 'Card retired', s: `${c.uid} replaced by ${next}` });
            }
          }
          events.sort((a, b) => a.at.getTime() - b.at.getTime());
          detail = (
            <div className="grid">
              <section className="card">
                <div className="row sp" style={{ alignItems: 'flex-start' }}>
                  <div className="row" style={{ gap: 16, flexWrap: 'nowrap' }}>
                    <div className="av" style={{ width: 64, height: 64, fontSize: 22 }}>{initials(sel.name)}</div>
                    <div>
                      <div className="mid" style={{ textTransform: 'uppercase', letterSpacing: '.02em' }}>{sel.name}</div>
                      <p className="sub num" style={{ marginTop: 4 }}>{sel.memberNumber} · {sel.mobile} · joined {ts(sel.createdAt)}</p>
                      <div className="row" style={{ marginTop: 10 }}><Tier tier={sel.tier} /><span>{sel.tier}</span><Tag kind={statusKind(sel.status)}>{sel.status}</Tag></div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="eyebrow">Wallet at {scope.one.name}</div>
                    <div className="big" style={{ margin: '8px 0 12px' }}>{inr(profile.balance)}</div>
                    {profile.balances.length > 1 && <p className="sub num" style={{ marginBottom: 10 }}>{profile.balances.map((b) => `${scope.outlets.find((x) => x.id === b.outletId)?.name}: ${inr(b.balance)}`).join(' · ')}</p>}
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <details className="pop">
                        <summary>Adjust balance</summary>
                        <div className="body" style={{ minWidth: 280 }}>
                          <form action={adjustWalletAction}>
                            <FormKeys back={back} />
                            <input type="hidden" name="memberId" value={sel.id} />
                            <input type="hidden" name="outletId" value={scope.one.id} />
                            <label htmlFor="dir">Direction</label>
                            <select id="dir" name="direction"><option value="cr">Credit: add to wallet</option><option value="dr">Debit: remove from wallet</option></select>
                            <label htmlFor="amount">Amount</label>
                            <Money name="amount" required min={0.01} />
                            <label htmlFor="reason">Reason (required)</label>
                            <input id="reason" name="reason" required minLength={3} placeholder="Why is this needed?" />
                            <div className="note">Posted as a new ledger entry at {scope.one.name}. Nothing already posted is changed.</div>
                            <button className="btn p s" style={{ marginTop: 12 }}>Post adjustment</button>
                          </form>
                        </div>
                      </details>
                      <details className="pop">
                        <summary>{sel.status === 'active' ? 'Suspend' : 'Reactivate'}</summary>
                        <div className="body" style={{ minWidth: 260 }}>
                          <form action={setMemberStatusAction}>
                            <FormKeys back={back} />
                            <input type="hidden" name="memberId" value={sel.id} />
                            <input type="hidden" name="status" value={sel.status === 'active' ? 'suspended' : 'active'} />
                            <label htmlFor="why">Reason</label>
                            <input id="why" name="reason" required />
                            <button className={`btn s ${sel.status === 'active' ? 'd' : 'p'}`} style={{ marginTop: 12 }}>{sel.status === 'active' ? 'Suspend member' : 'Reactivate member'}</button>
                          </form>
                        </div>
                      </details>
                    </div>
                  </div>
                </div>
              </section>
              <div className="grid cols11">
                <section className="card">
                  <h2>Card history</h2>
                  <p className="sub">The profile and wallet stay the same across cards.</p>
                  <ul className="timeline">
                    {events.map((e, i) => (
                      <li key={i} className={e.k}><span className="t">{ts(e.at)}</span><b>{e.b}</b><small>{e.s}</small></li>
                    ))}
                    {!events.length && <li><b>No card yet</b><small>Issue one at the counter.</small></li>}
                  </ul>
                </section>
                <section className="card">
                  <h2>Wallet ledger</h2>
                  <p className="sub">Newest first, with the balance after each posting.</p>
                  <div className="scroll mt">
                    <table className="tbl">
                      <tbody>
                        {ledger.map((l) => (
                          <tr key={l.id}>
                            <td><b style={{ fontWeight: 600 }}>{TYPE_LABEL[l.type] ?? l.type}</b><br /><small className="sub">{ts(l.createdAt)}{l.reason ? ` · ${l.reason}` : ''}</small></td>
                            <td className={`r num ${l.direction === 'cr' ? 'pos' : 'neg'}`}>{l.direction === 'cr' ? '+' : '−'}{inr(l.amount)}</td>
                            <td className="r num" style={{ color: 'var(--mut)' }}>{inr(l.balanceAfter)}</td>
                          </tr>
                        ))}
                        {!ledger.length && <tr><td className="sub" style={{ padding: 20 }}>No wallet activity at this outlet.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </div>
          );
        }
        return (
          <div className="split">
            <section className="card list">
              <form action="/owner/members" method="get">
                <input type="hidden" name="o" value={scope.selected} />
                {f !== 'All' && <input type="hidden" name="f" value={f} />}
                <input name="q" defaultValue={q} placeholder="Search name, ID, mobile or card" aria-label="Search members" />
              </form>
              <div className="chips" role="group" aria-label="Filter">
                {FILTERS.map((x) => <Link key={x} aria-pressed={x === f} href={`/owner/members?${new URLSearchParams({ o: scope.selected, ...(q ? { q } : {}), ...(x !== 'All' ? { f: x } : {}) })}`}>{x}</Link>)}
              </div>
              <div role="listbox" aria-label="Members">
                {list.map((x) => (
                  <Link key={x.id} className="it" role="option" aria-selected={x.id === sel?.id} href={href({ m: x.id })}>
                    <div className="av">{initials(x.name)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}><b>{x.name} <Tier tier={x.tier} /></b><small>{x.memberNumber} · {x.activeCardUid ?? 'no active card'}</small></div>
                    <span className="num" style={{ fontSize: 13 }}>{inr(x.balance)}</span>
                  </Link>
                ))}
                {!list.length && <p className="sub" style={{ padding: 14 }}>No members match. Clear the filter or search again.</p>}
              </div>
            </section>
            {detail ?? <section className="card"><h2>No member selected</h2><p className="sub">Pick someone from the list.</p></section>}
          </div>
        );
      }}
    </OwnerShell>
  );
}
