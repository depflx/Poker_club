import Link from 'next/link';
import {
  chipsAction, closeSessionAction, createRoundAction, leaveSeatAction, openSessionAction, seatPlayerAction, submitRoundAction,
} from '@/app/actions/staff';
import { StaffShell } from '@/app/staff/StaffShell';
import { CardInput } from '@/components/CardInput';
import { Pit } from '@/components/Pit';
import { FormKeys, Money, Tag, Tier, inr } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listRounds, sessionSummary, tablesBoard } from '@/server/poker';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tables · DepFlx Staff' };

export default async function DealerFloor({ searchParams }: { searchParams: Promise<{ o?: string; t?: string; seat?: string }> }) {
  const ctx = await requireCtx(['dealer']);
  const { o, t, seat } = await searchParams;
  const db = await getDb();
  return (
    <StaffShell ctx={ctx} current="/staff/floor" title="Tables" eyebrow="Seat, chip, record" o={o} surface="floor">
      {async (scope) => {
        const outlet = scope.one!;
        const boards = await tablesBoard(db, ctx, outlet.id);
        const q = (id: string, extra = '') => `/staff/floor?o=${outlet.id}&t=${id}${extra}`;
        if (!t) {
          return (
            <>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
                {boards.map((b) => (
                  <section key={b.table.id} className="card">
                    <div className="row sp"><h2>{b.table.name}</h2>{b.session ? <Tag kind="ok">In play</Tag> : <Tag kind={b.table.active ? '' : 'bad'}>{b.table.active ? 'Idle' : 'Off'}</Tag>}</div>
                    <p className="sub" style={{ margin: '6px 0 10px' }}>{b.session ? `${b.players.length} of ${b.table.maxSeats} seated` : 'No session'}</p>
                    <div className="meter" style={{ height: 8, background: 'var(--soft)', borderRadius: 9, overflow: 'hidden' }}><div style={{ height: '100%', width: `${(b.players.length / b.table.maxSeats) * 100}%`, background: b.players.length >= b.table.maxSeats ? 'var(--amber)' : 'var(--baize)' }} /></div>
                    <div className="row mt">
                      {b.session ? <Link className="btn p" href={q(b.table.id)}>Open table</Link> : b.table.active && (
                        <form action={openSessionAction}><FormKeys back="/staff/floor" /><input type="hidden" name="tableId" value={b.table.id} /><button className="btn p">Start session</button></form>
                      )}
                    </div>
                  </section>
                ))}
                {!boards.length && <div className="card"><h2>No tables yet</h2><p className="sub">The owner adds tables under Settings.</p></div>}
              </div>
              <p className="note">A table seats at most eight. A ninth player is turned away, even if two dealers try at once.</p>
            </>
          );
        }
        const sel = boards.find((b) => b.table.id === t) ?? boards[0];
        const back = q(sel.table.id, seat ? `&seat=${seat}` : '');
        if (!sel.session) {
          return (
            <div className="card" style={{ textAlign: 'center', padding: '60px 20px' }}>
              <div className="mid" style={{ marginBottom: 8 }}>{sel.table.name} is idle</div>
              <form action={openSessionAction}><FormKeys back="/staff/floor" /><input type="hidden" name="tableId" value={sel.table.id} /><button className="btn p">Start session</button></form>
              <p className="mt"><Link href={`/staff/floor?o=${outlet.id}`} style={{ textDecoration: 'underline' }}>All tables</Link></p>
            </div>
          );
        }
        const session = sel.session;
        const sum = await sessionSummary(db, ctx, session.id);
        const rounds = await listRounds(db, ctx, session.id);
        const nm = (id: string | null) => sel.players.find((p) => p.memberId === id)?.name ?? '—';
        const seatNo = seat ? Number(seat) : null;
        const picked = sel.players.find((p) => p.seatNumber === seatNo);
        const drafts = rounds.filter((r) => r.status === 'draft');
        return (
          <>
            <p style={{ marginBottom: 14 }}><Link href={`/staff/floor?o=${outlet.id}`} style={{ textDecoration: 'underline' }}>← All tables</Link></p>
            <div className="grid cols21">
              <section className="card" style={{ padding: '12px 12px 4px' }}>
                <div className="row sp" style={{ padding: '8px 14px' }}>
                  <div className="eyebrow">{sel.table.name}</div>
                  <Tag kind={sel.players.length >= sel.table.maxSeats ? 'warn' : 'ok'}>{sel.players.length >= sel.table.maxSeats ? `Table full · ${sel.table.maxSeats} of ${sel.table.maxSeats}` : `${sel.players.length} of ${sel.table.maxSeats} seated`}</Tag>
                </div>
                <Pit
                  label={`Seating at ${sel.table.name}`} maxSeats={sel.table.maxSeats} selected={seatNo}
                  seats={sel.players.map((p) => ({ seatNumber: p.seatNumber, name: p.name, chipsOut: p.chipsOut }))}
                  seatHref={(n) => q(sel.table.id, `&seat=${n}`)}
                  center={{ label: rounds[0] ? `Round ${rounds[0].roundNumber}${rounds[0].status === 'draft' ? ' · in play' : ''}` : 'No rounds yet', value: rounds[0] ? inr(rounds[0].pot) : '—', sub: 'Entered by you' }}
                />
              </section>
              <div className="grid" style={{ alignContent: 'start' }}>
                <section className="card">
                  <h2>Seat a player</h2>
                  <p className="sub">Tap the member’s card. The server checks the card, the member and the seat count.</p>
                  <form action={seatPlayerAction}>
                    <FormKeys back={back} /><input type="hidden" name="sessionId" value={session.id} />
                    <CardInput />
                    <button className="btn p" style={{ marginTop: 14 }}>Seat player</button>
                  </form>
                </section>
                {picked && (
                  <section className="card">
                    <h2>Seat {picked.seatNumber} · {picked.name} <Tier tier={picked.tier} /></h2>
                    <p className="sub num">{picked.memberNumber} · chips out {inr(picked.chipsOut)}</p>
                    {(['issue', 'return'] as const).map((k) => (
                      <form key={k} action={chipsAction} className="row mt" style={{ alignItems: 'flex-end' }}>
                        <FormKeys back={back} />
                        <input type="hidden" name="sessionId" value={session.id} /><input type="hidden" name="memberId" value={picked.memberId} /><input type="hidden" name="kind" value={k} />
                        <div><label>{k === 'issue' ? 'Issue chips' : 'Return chips'}</label><Money name="amount" required min={1} /></div>
                        <button className={`btn ${k === 'issue' ? 'p' : ''}`}>{k === 'issue' ? 'Issue' : 'Return'}</button>
                      </form>
                    ))}
                    <form action={leaveSeatAction} className="mt">
                      <FormKeys back={q(sel.table.id)} /><input type="hidden" name="sessionId" value={session.id} /><input type="hidden" name="memberId" value={picked.memberId} />
                      <button className="btn s d">Player leaves</button>
                    </form>
                  </section>
                )}
                <section className="card">
                  <h2>Chips on this table</h2>
                  <div className="kpis mt">
                    <div><div className="eyebrow">Issued</div><div className="mid">{inr(sum.issued)}</div></div>
                    <div><div className="eyebrow">Returned</div><div className="mid">{inr(sum.returned)}</div></div>
                    <div><div className="eyebrow">Out</div><div className="mid" style={{ color: 'var(--brassTx)' }}>{inr(sum.outstanding)}</div></div>
                  </div>
                </section>
              </div>
            </div>

            <div className="grid cols11 mt">
              <section className="card">
                <h2>New round</h2>
                <p className="sub">You enter what happened. The system does not decide winners.</p>
                <form action={createRoundAction}>
                  <FormKeys back={back} /><input type="hidden" name="sessionId" value={session.id} />
                  <label>Players in the round</label>
                  {sel.players.map((p) => (
                    <label key={p.memberId} style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit', fontSize: 14, color: 'var(--ink)', display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }}>
                      <input type="checkbox" name="participants" value={p.memberId} defaultChecked style={{ width: 'auto', minHeight: 0 }} />Seat {p.seatNumber} · {p.name}
                    </label>
                  ))}
                  <label htmlFor="winner">Winner</label>
                  <select id="winner" name="winner" defaultValue=""><option value="">No winner yet</option>{sel.players.map((p) => <option key={p.memberId} value={p.memberId}>{p.name}</option>)}</select>
                  <label>Pot</label><Money name="pot" />
                  <label htmlFor="notes">Notes</label><input id="notes" name="notes" />
                  <div className="row mt">
                    <button className="btn p" name="submit" value="yes">Submit round</button>
                    <button className="btn" name="submit" value="no">Save draft</button>
                  </div>
                </form>
              </section>
              <section className="card">
                <h2>Rounds</h2>
                <p className="sub">A submitted round is locked. Only the owner can correct it.</p>
                <div className="mt">
                  {rounds.map((r) => (
                    <div className="dec" key={r.id}>
                      <i className={r.status === 'draft' ? '' : 'ok'} />
                      <div><b>Round {r.roundNumber} <Tag kind={r.status === 'draft' ? 'warn' : 'ok'}>{r.status}</Tag></b><p>{r.winnerMemberId ? `Winner: ${nm(r.winnerMemberId)}` : 'No winner entered'} · pot <span className="num">{inr(r.pot)}</span>{r.corrections.length ? ' · corrected by owner' : ''}</p></div>
                      {r.status === 'draft' && <form action={submitRoundAction}><FormKeys back={back} /><input type="hidden" name="roundId" value={r.id} /><button className="btn s p">Submit</button></form>}
                    </div>
                  ))}
                  {!rounds.length && <p className="sub">No rounds yet.</p>}
                </div>
                <div className="grp mt">Close the session</div>
                <form action={closeSessionAction}>
                  <FormKeys back={back} /><input type="hidden" name="sessionId" value={session.id} /><input type="hidden" name="outletId" value={outlet.id} />
                  {sum.outstanding > 0 && <div className="note" style={{ marginTop: 0 }}>{inr(sum.outstanding)} of chips are still out. Return them first, or note the exception below.</div>}
                  <label htmlFor="exc">{sum.outstanding > 0 ? 'Exception note (required)' : 'Exception note (only if chips are out)'}</label>
                  <input id="exc" name="exceptionNote" placeholder="e.g. Player left with chips, settles tomorrow" required={sum.outstanding > 0} />
                  {drafts.length > 0 && <p className="sub" style={{ marginTop: 8 }}>Submit the draft round before closing.</p>}
                  <button className="btn d" style={{ marginTop: 12 }}>Close session</button>
                </form>
              </section>
            </div>
          </>
        );
      }}
    </StaffShell>
  );
}
