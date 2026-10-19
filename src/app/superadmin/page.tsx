import { createOwnerAction, setOwnerStatusAction, updateOwnerAction } from '@/app/actions/superadmin';
import { impersonateAction } from '@/app/actions/auth';
import { SA_NAV } from '@/app/superadmin/nav';
import { Shell } from '@/components/Shell';
import { FormKeys, Tag, statusKind, ts } from '@/components/ui';
import { getDb } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listOwners, platformStats } from '@/server/superadmin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Platform · DepFlx' };

export default async function SuperadminHome() {
  const ctx = await requireCtx(['superadmin']);
  const db = await getDb();
  const [owners, stats] = await Promise.all([listOwners(db, ctx), platformStats(db, ctx)]);
  const back = '/superadmin';

  return (
    <Shell ctx={ctx} nav={SA_NAV} current="/superadmin" title="Owners" eyebrow="Platform" brandSub="Platform admin"
      meta={<span className="live"><i />{stats.activeOwners} of {stats.owners} owners active</span>}>
      <div className="grid cols3">
        <div className="card"><div className="eyebrow">Owners</div><div className="mid" style={{ marginTop: 8 }}>{stats.owners}</div></div>
        <div className="card"><div className="eyebrow">Active outlets</div><div className="mid" style={{ marginTop: 8 }}>{stats.outlets}</div></div>
        <div className="card"><div className="eyebrow">People with logins</div><div className="mid" style={{ marginTop: 8 }}>{stats.users}</div></div>
      </div>

      <section className="card mt" aria-labelledby="owners-h">
        <h2 id="owners-h">All owners</h2>
        <p className="sub">Each owner is a separate club account. Their outlets, staff and members are walled off from every other owner.</p>
        <div className="scroll mt">
          <table className="tbl">
            <thead>
              <tr><th>Club</th><th>Plan</th><th>Outlets</th><th>Staff</th><th>Since</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {owners.map((o) => (
                <tr key={o.id}>
                  <td><b style={{ fontWeight: 600 }}>{o.name}</b></td>
                  <td>{o.plan}</td>
                  <td className="num">{o.outletCount} / {o.outletLimit}</td>
                  <td className="num">{o.staffCount}</td>
                  <td className="num" style={{ fontSize: 13 }}>{ts(o.createdAt)}</td>
                  <td><Tag kind={statusKind(o.status)}>{o.status}</Tag></td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <details className="pop">
                        <summary>Plan and limit</summary>
                        <div className="body">
                          <form action={updateOwnerAction}>
                            <FormKeys back={back} />
                            <input type="hidden" name="ownerId" value={o.id} />
                            <label htmlFor={`plan-${o.id}`}>Plan</label>
                            <select id={`plan-${o.id}`} name="plan" defaultValue={o.plan}>
                              <option value="trial">Trial</option><option value="standard">Standard</option><option value="pro">Pro</option>
                            </select>
                            <label htmlFor={`lim-${o.id}`}>Outlet limit</label>
                            <input id={`lim-${o.id}`} name="outletLimit" type="number" min={1} max={50} defaultValue={o.outletLimit} />
                            <button className="btn p s" style={{ marginTop: 12 }}>Save</button>
                          </form>
                        </div>
                      </details>
                      <details className="pop">
                        <summary>{o.status === 'active' ? 'Suspend' : 'Reactivate'}</summary>
                        <div className="body">
                          <form action={setOwnerStatusAction}>
                            <FormKeys back={back} />
                            <input type="hidden" name="ownerId" value={o.id} />
                            <input type="hidden" name="status" value={o.status === 'active' ? 'suspended' : 'active'} />
                            <label htmlFor={`why-${o.id}`}>Reason</label>
                            <input id={`why-${o.id}`} name="reason" required={o.status === 'active'} placeholder="Why?" />
                            <button className={`btn s ${o.status === 'active' ? 'd' : 'p'}`} style={{ marginTop: 12 }}>
                              {o.status === 'active' ? 'Suspend and sign out everyone' : 'Reactivate'}
                            </button>
                          </form>
                        </div>
                      </details>
                      {o.status === 'active' && (
                        <form action={impersonateAction}>
                          <input type="hidden" name="ownerId" value={o.id} />
                          <button className="btn s">Open console</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!owners.length && <tr><td colSpan={7} className="sub" style={{ padding: 24 }}>No owners yet. Add the first one below.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card mt" aria-labelledby="new-h">
        <h2 id="new-h">Add an owner</h2>
        <p className="sub">Creates the club account, the owner’s login and, if you name one, their first outlet.</p>
        <form action={createOwnerAction} className="grid cols3" style={{ alignItems: 'end' }}>
          <FormKeys back={back} />
          <div><label htmlFor="name">Club name</label><input id="name" name="name" required minLength={2} /></div>
          <div>
            <label htmlFor="plan">Plan</label>
            <select id="plan" name="plan" defaultValue="trial"><option value="trial">Trial</option><option value="standard">Standard</option><option value="pro">Pro</option></select>
          </div>
          <div><label htmlFor="outletLimit">Outlet limit</label><input id="outletLimit" name="outletLimit" type="number" min={1} max={50} defaultValue={1} /></div>
          <div><label htmlFor="ownerName">Owner name</label><input id="ownerName" name="ownerName" required minLength={2} /></div>
          <div><label htmlFor="ownerEmail">Owner email</label><input id="ownerEmail" name="ownerEmail" type="email" required autoComplete="off" /></div>
          <div><label htmlFor="password">Starting password</label><input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" /></div>
          <div><label htmlFor="outletName">First outlet (optional)</label><input id="outletName" name="outletName" /></div>
          <div><label htmlFor="outletCode">Outlet code</label><input id="outletCode" name="outletCode" maxLength={8} placeholder="AND" /></div>
          <div><button className="btn p">Create owner</button></div>
        </form>
      </section>
    </Shell>
  );
}
