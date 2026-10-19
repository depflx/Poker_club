import Link from 'next/link';
import { correctRoundAction } from '@/app/actions/owner';
import { OwnerShell } from '@/app/owner/OwnerShell';
import { Pit } from '@/components/Pit';
import { FormKeys, Money, Tag, Tier, initials, inr } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listRounds, sessionSummary, tablesBoard } from '@/server/poker';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Floor · DepFlx Owner' };

export default async function OwnerFloor({ searchParams }: { searchParams: Promise<{ o?: string; t?: string; seat?: string }> }) {
  const ctx = await requireCtx(['owner']);
  const { o, t, seat } = await searchParams;
  const db = await getDb();
  return (
    <OwnerShell ctx={ctx} current="/owner/floor" title="The floor" eyebrow="Live" o={o} defaultAll surface="floor">
      {async (scope) => {
        const boards = (await Promise.all(scope.ids.map(async (id) => (await tablesBoard(db, ctx, id)).map((b) => ({ ...b, outletName: scope.outlets.find((x) => x.id === id)?.name ?? '' }))))).flat();
        if (!boards.length) {
          return <div className="card" style={{ textAlign: 'center', padding: '60px 20px' }}><div className="mid">No tables yet</div><p className="sub" style={{ marginTop: 8 }}>Add tables under Settings, then dealers can start sessions from their tablets.</p></div>;
        }
        const sel = boards.find((b) => b.table.id === t) ?? boards.find((b) => b.session) ?? boards[0];
        const q = (id: string) => `/owner/floor?o=${scope.selected}&t=${id}`;
        const sum = sel.session ? await sessionSummary(db, ctx, sel.session.id) : null;
        const rounds = sel.session ? await listRounds(db, ctx, sel.session.id) : [];
        const name = (id: string | null) => sel.players.find((p) => p.memberId === id)?.name ?? '—';
        const seatNo = seat ? Number(seat) : null;
        return (
          <>
            <div className="tabs" role="tablist">
              {boards.map((b) => (
                <Link key={b.table.id} role="tab" aria-selected={b.table.id === sel.table.id} href={q(b.table.id)}>
                  {b.table.name}{scope.isAll ? ` · ${b.outletName}` : ''}<span className="num">{b.players.length}/{b.table.maxSeats}</span>
                </Link>
              ))}
            </div>
            {!sel.session ? (
              <div className="card" style={{ textAlign: 'center', padding: '60px 20px' }}>
                <div className="mid" style={{ marginBottom: 8 }}>{sel.table.name} is idle</div>
                <p className="sub">No session is open. A dealer starts a session from the tablet at the table.</p>
              </div>
            ) : (
              <>
                <div className="grid cols21">
                  <section className="card" style={{ padding: '12px 12px 4px' }}>
                    <div className="row sp" style={{ padding: '8px 14px' }}>
                      <div className="eyebrow">{sel.table.name} · started {new Date(sel.session.startedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</div>
                      <Tag kind={sel.players.length >= sel.table.maxSeats ? 'warn' : 'ok'}>{sel.players.length >= sel.table.maxSeats ? `Table full · ${sel.table.maxSeats} of ${sel.table.maxSeats}` : `${sel.players.length} of ${sel.table.maxSeats} seated`}</Tag>
                    </div>
                    <Pit
                      label={`Seating at ${sel.table.name}`} maxSeats={sel.table.maxSeats} selected={seatNo}
                      seats={sel.players.map((p) => ({ seatNumber: p.seatNumber, name: p.name, chipsOut: p.chipsOut }))}
                      seatHref={(n) => `${q(sel.table.id)}&seat=${n}`}
                      center={{ label: rounds[0] ? `Round ${rounds[0].roundNumber}${rounds[0].status === 'draft' ? ' · in play' : ''}` : 'No rounds yet', value: rounds[0] ? inr(rounds[0].pot) : '—', sub: 'Entered by the dealer' }}
                    />
                  </section>
                  <div className="grid" style={{ alignContent: 'start' }}>
                    <section className="card">
                      <h2>Chips on this table</h2>
                      <p className="sub">Physical chips, apart from wallet money.</p>
                      <div className="kpis mt">
                        <div><div className="eyebrow">Issued</div><div className="mid">{inr(sum?.issued ?? 0)}</div></div>
                        <div><div className="eyebrow">Returned</div><div className="mid">{inr(sum?.returned ?? 0)}</div></div>
                        <div><div className="eyebrow">Outstanding</div><div className="mid" style={{ color: 'var(--brassTx)' }}>{inr(sum?.outstanding ?? 0)}</div></div>
                      </div>
                    </section>
                    <section className="card">
                      <h2>Rounds</h2>
                      <p className="sub">Entered by the dealer. The system does not verify winners.</p>
                      <div className="mt">
                        {rounds.map((r) => (
                          <div className="dec" key={r.id}>
                            <i className={r.status === 'draft' ? '' : 'ok'} />
                            <div>
                              <b>Round {r.roundNumber} <Tag kind={r.status === 'draft' ? 'warn' : 'ok'}>{r.status}</Tag></b>
                              <p>{r.winnerMemberId ? `Winner entered: ${name(r.winnerMemberId)}` : 'No winner entered yet'} · pot <span className="num">{inr(r.pot)}</span></p>
                              {r.corrections.map((c) => (
                                <div className="diff" style={{ marginTop: 8 }} key={c.id}>
                                  <span className="a">{name((c.before as { winnerMemberId: string | null }).winnerMemberId)}</span> → <span className="b">{name((c.after as { winnerMemberId: string | null }).winnerMemberId)}</span><br />{c.reason}
                                </div>
                              ))}
                              {r.status === 'submitted' && (
                                <details className="pop" style={{ marginTop: 8 }}>
                                  <summary>Correct this round</summary>
                                  <div className="body">
                                    <form action={correctRoundAction}>
                                      <FormKeys back={`${q(sel.table.id)}`} />
                                      <input type="hidden" name="roundId" value={r.id} />
                                      <label htmlFor={`w-${r.id}`}>Winner</label>
                                      <select id={`w-${r.id}`} name="winner" defaultValue={r.winnerMemberId ?? ''}>
                                        {r.participants.map((id) => <option key={id} value={id}>{name(id)}</option>)}
                                      </select>
                                      <label htmlFor={`p-${r.id}`}>Pot</label>
                                      <Money name="pot" defaultValue={r.pot / 100} />
                                      <label htmlFor={`r-${r.id}`}>Reason (required)</label>
                                      <input id={`r-${r.id}`} name="reason" required placeholder="What was wrong?" />
                                      <button className="btn p s" style={{ marginTop: 12 }}>Record correction</button>
                                    </form>
                                  </div>
                                </details>
                              )}
                            </div>
                          </div>
                        ))}
                        {!rounds.length && <p className="sub">No rounds yet.</p>}
                      </div>
                    </section>
                  </div>
                </div>
                <section className="card mt">
                  <h2>Seats</h2>
                  <div className="scroll mt">
                    <table className="tbl">
                      <thead><tr><th>Seat</th><th>Player</th><th className="r">Chips out</th></tr></thead>
                      <tbody>
                        {sel.players.map((p) => (
                          <tr key={p.memberId} className={seatNo === p.seatNumber ? 'sel' : ''}>
                            <td className="num">{p.seatNumber}</td>
                            <td>
                              <div className="row" style={{ flexWrap: 'nowrap' }}>
                                <div className="av" style={{ width: 32, height: 32, fontSize: 12 }}>{initials(p.name)}</div>
                                <div><b style={{ fontWeight: 600 }}>{p.name}</b> <Tier tier={p.tier} /><br /><small className="num" style={{ color: 'var(--mut)' }}>{p.memberNumber}</small></div>
                              </div>
                            </td>
                            <td className="r num">{inr(p.chipsOut)}</td>
                          </tr>
                        ))}
                        {!sel.players.length && <tr><td colSpan={3} className="sub" style={{ padding: 20 }}>Nobody is seated yet.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </>
        );
      }}
    </OwnerShell>
  );
}
