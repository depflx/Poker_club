import { closeShiftAction, openShiftAction } from '@/app/actions/staff';
import { StaffShell } from '@/app/staff/StaffShell';
import { FormKeys, Money, Tag, inr, statusKind, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { currentShift, myShifts } from '@/server/shifts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My shift · DepFlx Staff' };

const LABEL: Record<string, string> = { open: 'Open', review: 'Waiting for the owner', approved: 'Approved and locked' };

export default async function ShiftPage({ searchParams }: { searchParams: Promise<{ o?: string }> }) {
  const ctx = await requireCtx(['cashier']);
  const { o } = await searchParams;
  const db = await getDb();
  return (
    <StaffShell ctx={ctx} current="/staff/shift" title="My shift" eyebrow="Open, count, close" o={o}>
      {async (scope) => {
        const outlet = scope.one!;
        const back = `/staff/shift?o=${outlet.id}`;
        const cur = await currentShift(db, ctx, outlet.id);
        const history = await myShifts(db, ctx, outlet.id, 6);
        return (
          <div className="grid cols2">
            <section className="card">
              {!cur ? (
                <>
                  <h2>Open a shift</h2>
                  <p className="sub">Count the float in the till first. Every payment you take lands in this shift.</p>
                  <form action={openShiftAction}>
                    <FormKeys back={back} /><input type="hidden" name="outletId" value={outlet.id} />
                    <label htmlFor="open">Opening cash</label><Money name="openingCash" required />
                    <button className="btn p" style={{ marginTop: 16 }}>Open shift</button>
                  </form>
                </>
              ) : (
                <>
                  <div className="row sp"><h2>Close this shift</h2><Tag kind="ok">Open since {ts(cur.shift.openedAt)}</Tag></div>
                  <p className="sub">Count what is actually in the till and settlement slips. Differences are reported, not hidden.</p>
                  <div className="shiftcmp">
                    {(['cash', 'card', 'upi'] as const).map((k) => (
                      <div className="cmp" key={k}>
                        <div className="eyebrow">{k}</div>
                        <div className="l"><span>Expected{k === 'cash' ? ' · with float' : ''}</span><span className="num" style={{ color: 'var(--ink)' }}>{inr(cur.expected[k])}</span></div>
                      </div>
                    ))}
                  </div>
                  <form action={closeShiftAction}>
                    <FormKeys back={back} /><input type="hidden" name="shiftId" value={cur.shift.id} />
                    <div className="grid cols3">
                      <div><label>Cash counted</label><Money name="cash" required /></div>
                      <div><label>Card settled</label><Money name="card" required /></div>
                      <div><label>UPI settled</label><Money name="upi" required /></div>
                    </div>
                    <label htmlFor="note">Note on any difference</label>
                    <input id="note" name="note" placeholder="Needed only if the counts do not match" />
                    <button className="btn p" style={{ marginTop: 16 }}>Submit for review</button>
                  </form>
                </>
              )}
            </section>
            <section className="card">
              <h2>Recent shifts</h2>
              <div className="mt">
                {history.map((s) => (
                  <div className="bk" key={s.id} style={{ gridTemplateColumns: '1fr auto' }}>
                    <div><b style={{ fontWeight: 500 }}>{ts(s.openedAt)}</b><p>Float {inr(s.openingCash)}{s.reviewNote ? ` · Owner: ${s.reviewNote}` : ''}</p></div>
                    <Tag kind={statusKind(s.status)}>{LABEL[s.status]}</Tag>
                  </div>
                ))}
                {!history.length && <p className="sub">No shifts yet.</p>}
              </div>
            </section>
          </div>
        );
      }}
    </StaffShell>
  );
}
