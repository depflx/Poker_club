import Link from 'next/link';
import { SA_NAV } from '@/app/superadmin/nav';
import { Shell } from '@/components/Shell';
import { Tag, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listPlatformAudit } from '@/server/audit';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Platform audit · DepFlx' };

const CATS = ['All', 'Platform', 'Auth', 'Outlets', 'Staff', 'Settings'];

export default async function PlatformAudit({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const ctx = await requireCtx(['superadmin']);
  const { c = 'All' } = await searchParams;
  const rows = await listPlatformAudit(await getDb(), ctx, { category: c === 'All' ? undefined : c });
  return (
    <Shell ctx={ctx} nav={SA_NAV} current="/superadmin/audit" title="Platform audit" eyebrow="Append-only" brandSub="Platform admin">
      <div className="chips" role="group" aria-label="Category">
        {CATS.map((x) => (
          <Link key={x} href={`/superadmin/audit?c=${x}`} aria-pressed={x === c}>{x}</Link>
        ))}
      </div>
      <section className="card" style={{ padding: '8px 14px' }}>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Detail</th><th></th></tr></thead>
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
              {!rows.length && <tr><td colSpan={5} className="sub" style={{ padding: 24 }}>No events yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
