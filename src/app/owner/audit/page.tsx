import Link from 'next/link';
import { OwnerShell } from '@/app/owner/OwnerShell';
import { Tag, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listAudit } from '@/server/audit';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit trail · DepFlx Owner' };

const CATS = ['All', 'Cards', 'Wallet', 'Chips', 'Rounds', 'Shifts', 'Food', 'Staff', 'Settings', 'Members', 'Outlets'];

export default async function OwnerAudit({ searchParams }: { searchParams: Promise<{ o?: string; c?: string; q?: string }> }) {
  const ctx = await requireCtx(['owner']);
  const { o, c = 'All', q = '' } = await searchParams;
  const db = await getDb();
  return (
    <OwnerShell ctx={ctx} current="/owner/audit" title="Audit trail" eyebrow="Append-only" o={o} defaultAll>
      {async (scope) => {
        const rows = await listAudit(db, ctx, { category: c === 'All' ? undefined : c, q: q || undefined, outletId: scope.isAll ? undefined : scope.selected });
        return (
          <>
            <div className="row sp">
              <div className="chips" role="group" aria-label="Category">
                {CATS.map((x) => <Link key={x} aria-pressed={x === c} href={`/owner/audit?${new URLSearchParams({ o: scope.selected, ...(x !== 'All' ? { c: x } : {}), ...(q ? { q } : {}) })}`}>{x}</Link>)}
              </div>
              <form action="/owner/audit" method="get" style={{ width: 'min(340px,100%)' }}>
                <input type="hidden" name="o" value={scope.selected} />
                {c !== 'All' && <input type="hidden" name="c" value={c} />}
                <input name="q" defaultValue={q} placeholder="Search action, reference or reason" aria-label="Search audit trail" />
              </form>
            </div>
            <section className="card" style={{ padding: '8px 14px' }}>
              <div className="scroll">
                <table className="tbl">
                  <thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Change</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="num" style={{ fontSize: 13 }}>{ts(r.createdAt)}</td>
                        <td>{r.actorRole}{r.impersonatorId ? <><br /><small className="sub">via support session</small></> : null}</td>
                        <td><b style={{ fontWeight: 600 }}>{r.action}</b>{r.reason ? <><br /><small className="sub">{r.reason}</small></> : null}</td>
                        <td>
                          {r.before || r.after ? (
                            <div className="diff">
                              {r.before ? <span className="a">− {JSON.stringify(r.before)}</span> : null}
                              {r.before && r.after ? <br /> : null}
                              {r.after ? <span className="b">+ {JSON.stringify(r.after)}</span> : null}
                            </div>
                          ) : <span className="sub">—</span>}
                        </td>
                        <td><Tag>{r.category}</Tag></td>
                      </tr>
                    ))}
                    {!rows.length && <tr><td colSpan={5} className="sub" style={{ padding: 24 }}>No events match.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <p className="sub mt">Nobody can edit or delete these rows. Changes are corrected with new entries.</p>
          </>
        );
      }}
    </OwnerShell>
  );
}
