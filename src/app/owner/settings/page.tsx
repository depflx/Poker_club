import Link from 'next/link';
import { eq } from 'drizzle-orm';
import {
  addMenuItemAction, createOutletAction, createStaffAction, createTableAction, resetStaffPasswordAction, updateMenuItemAction,
  updateOutletAction, updateSettingsAction, updateStaffAction, updateTableAction,
} from '@/app/actions/owner';
import { OwnerShell } from '@/app/owner/OwnerShell';
import { FormKeys, Money, Tag, Tier, statusKind, ts } from '@/components/ui';
import { getDb, schema } from '@/db/client';
import { requireCtx } from '@/lib/session';
import { listMenu } from '@/server/food';
import { getSettings, listOutlets } from '@/server/outlets';
import { tablesBoard } from '@/server/poker';
import { listStaff } from '@/server/staff';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings · DepFlx Owner' };

const TABS = [['rules', 'Club rules'], ['menu', 'Food menu'], ['tables', 'Tables'], ['staff', 'Staff'], ['outlets', 'Outlets']] as const;
const ROLE: Record<string, string> = { cashier: 'Cashier', dealer: 'Dealer', waiter: 'Waiter', kds: 'Kitchen (KDS)', owner: 'Owner' };

export default async function OwnerSettings({ searchParams }: { searchParams: Promise<{ o?: string; t?: string }> }) {
  const ctx = await requireCtx(['owner']);
  const { o, t = 'rules' } = await searchParams;
  const db = await getDb();
  return (
    <OwnerShell ctx={ctx} current="/owner/settings" title="Settings" eyebrow="Rules, menu, tables, people" o={o}>
      {async (scope) => {
        const outlet = scope.one;
        const back = `/owner/settings?o=${scope.selected}&t=${t}`;
        const tabs = (
          <div className="tabs" role="tablist">
            {TABS.map(([k, label]) => <Link key={k} role="tab" aria-selected={k === t} href={`/owner/settings?o=${scope.selected}&t=${k}`}>{label}</Link>)}
          </div>
        );
        if (!outlet && t !== 'outlets') return <>{tabs}<div className="card"><h2>No outlet yet</h2><p className="sub">Create an outlet first.</p></div></>;

        if (t === 'rules' && outlet) {
          const s = await getSettings(db, ctx, outlet.id);
          return (
            <>{tabs}
              <form action={updateSettingsAction} className="card">
                <FormKeys back={back} />
                <input type="hidden" name="outletId" value={outlet.id} />
                <div className="row sp"><h2>Rules for {outlet.name}</h2><Tag>Per outlet</Tag></div>
                <div className="field"><div><b>Guest food</b></div>
                  <select name="guestMode" defaultValue={s.guestMode} aria-label="Guest food" style={{ width: 180 }}><option value="free">Free</option><option value="chargeable">Chargeable</option></select>
                  <p>Player food is always free and cannot be changed. This only applies to guests.</p></div>
                <div className="field"><div><b>Guest charges go to</b></div>
                  <select name="guestPayer" defaultValue={s.guestPayer} aria-label="Guest charges go to" style={{ width: 220 }}><option value="player">The player’s wallet</option><option value="separate">Paid separately at the counter</option></select>
                  <p>Either way the order stays marked as a guest order and names the member who brought them.</p></div>
                <div className="field"><div><b>Card issuance fee</b></div><Money name="issueFee" defaultValue={s.issueFee / 100} /><p>Collected at the counter. Never added to a wallet.</p></div>
                <div className="field"><div><b>Replacement card fee</b></div><Money name="replacementFee" defaultValue={s.replacementFee / 100} /><p>Separate from any wallet recharge.</p></div>
                <div className="field"><div><b>Second approval above</b></div><Money name="approvalThreshold" defaultValue={s.approvalThreshold / 100} min={1} /><p>Adjustments larger than this need a second owner account to approve.</p></div>
                <div className="field"><div><b>Cash-out of wallet balance</b></div><Tag>Off</Tag><p>Stays off until the club has legal and compliance approval. It cannot be switched on from here.</p></div>
                <div className="grp">Membership tier fees</div>
                {(['Bronze', 'Silver', 'Gold', 'Platinum'] as const).map((k) => (
                  <div className="field" key={k}><div><b><Tier tier={k} /> &nbsp;{k}</b></div><Money name={`tier_${k}`} defaultValue={s.tierFees[k] / 100} /></div>
                ))}
                <div className="mt"><button className="btn p">Save rules</button></div>
              </form>
            </>
          );
        }

        if (t === 'menu' && outlet) {
          const items = await listMenu(db, ctx, outlet.id);
          return (
            <>{tabs}
              <section className="card">
                <h2>Food menu · {outlet.name}</h2>
                <p className="sub">No stock tracking. Hiding an item removes it from waiters’ screens. Player prices are always ₹0.</p>
                <div className="mt">
                  {items.map((i) => (
                    <div className="menu-row" key={i.id}>
                      <div style={{ flex: 1 }}><b style={{ fontWeight: 600 }}>{i.name}</b><br /><small className="sub">{i.category}</small></div>
                      <form action={updateMenuItemAction} className="row">
                        <FormKeys back={back} /><input type="hidden" name="itemId" value={i.id} />
                        <Money name="guestPrice" defaultValue={i.guestPrice / 100} />
                        <button className="btn s">Save price</button>
                      </form>
                      <form action={updateMenuItemAction}>
                        <FormKeys back={back} /><input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="available" value={String(!i.available)} />
                        <button className={`btn s ${i.available ? 'p' : ''}`}>{i.available ? 'Available' : 'Hidden'}</button>
                      </form>
                    </div>
                  ))}
                  {!items.length && <p className="sub">No items yet.</p>}
                </div>
                <div className="grp mt">Add an item</div>
                <form action={addMenuItemAction} className="row" style={{ alignItems: 'flex-end' }}>
                  <FormKeys back={back} /><input type="hidden" name="outletId" value={outlet.id} />
                  <div style={{ flex: 1, minWidth: 180 }}><label htmlFor="mi-name">Name</label><input id="mi-name" name="name" required minLength={2} /></div>
                  <div style={{ width: 150 }}><label htmlFor="mi-cat">Category</label><input id="mi-cat" name="category" placeholder="Snacks" /></div>
                  <div><label>Guest price</label><Money name="guestPrice" /></div>
                  <button className="btn p">Add item</button>
                </form>
              </section>
            </>
          );
        }

        if (t === 'tables' && outlet) {
          const boards = await tablesBoard(db, ctx, outlet.id);
          return (
            <>{tabs}
              <section className="card">
                <h2>Tables · {outlet.name}</h2>
                <p className="sub">A table seats at most eight. A running session blocks changes until it is closed.</p>
                <div className="scroll mt">
                  <table className="tbl">
                    <thead><tr><th>Table</th><th>Seats</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {boards.map((b) => (
                        <tr key={b.table.id}>
                          <td><b style={{ fontWeight: 600 }}>{b.table.name}</b></td>
                          <td className="num">{b.table.maxSeats}</td>
                          <td>{b.session ? <Tag kind="ok">In play · {b.players.length} seated</Tag> : <Tag kind={b.table.active ? '' : 'bad'}>{b.table.active ? 'Idle' : 'Switched off'}</Tag>}</td>
                          <td className="r" style={{ textAlign: 'right' }}>
                            {!b.session && (
                              <form action={updateTableAction}>
                                <FormKeys back={back} /><input type="hidden" name="tableId" value={b.table.id} /><input type="hidden" name="active" value={String(!b.table.active)} />
                                <button className="btn s">{b.table.active ? 'Switch off' : 'Switch on'}</button>
                              </form>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grp mt">Add a table</div>
                <form action={createTableAction} className="row" style={{ alignItems: 'flex-end' }}>
                  <FormKeys back={back} /><input type="hidden" name="outletId" value={outlet.id} />
                  <div style={{ width: 220 }}><label htmlFor="t-name">Name</label><input id="t-name" name="name" required /></div>
                  <div style={{ width: 120 }}><label htmlFor="t-seats">Seats</label><input id="t-seats" name="maxSeats" type="number" min={2} max={8} defaultValue={8} /></div>
                  <button className="btn p">Add table</button>
                </form>
              </section>
            </>
          );
        }

        if (t === 'staff') {
          const staff = await listStaff(db, ctx);
          const outletName = (id: string) => scope.outlets.find((x) => x.id === id)?.name ?? '';
          return (
            <>{tabs}
              <section className="card">
                <h2>Staff and roles</h2>
                <p className="sub">Roles are enforced on the server, not only in the screens. Changing a role or disabling someone signs them out at once.</p>
                <div className="scroll mt">
                  <table className="tbl">
                    <thead><tr><th>Name</th><th>Role</th><th>Outlets</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {staff.map((s) => (
                        <tr key={s.id}>
                          <td><b style={{ fontWeight: 600 }}>{s.name}</b><br /><small className="sub">{s.email}</small></td>
                          <td>{ROLE[s.role]}</td>
                          <td>{s.role === 'owner' ? 'All' : s.outletIds.map(outletName).join(', ')}</td>
                          <td><Tag kind={statusKind(s.status)}>{s.status}</Tag></td>
                          <td>
                            {s.role !== 'owner' && (
                              <div className="row" style={{ justifyContent: 'flex-end' }}>
                                <details className="pop"><summary>Edit</summary>
                                  <div className="body" style={{ minWidth: 260 }}>
                                    <form action={updateStaffAction}>
                                      <FormKeys back={back} /><input type="hidden" name="userId" value={s.id} />
                                      <label htmlFor={`r-${s.id}`}>Role</label>
                                      <select id={`r-${s.id}`} name="role" defaultValue={s.role}>{(['cashier', 'dealer', 'waiter', 'kds'] as const).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select>
                                      <label>Outlets</label>
                                      {scope.outlets.map((x) => <label key={x.id} style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit', fontSize: 14, color: 'var(--ink)', display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }}><input type="checkbox" name="outletIds" value={x.id} defaultChecked={s.outletIds.includes(x.id)} style={{ width: 'auto', minHeight: 0 }} />{x.name}</label>)}
                                      <label htmlFor={`s-${s.id}`}>Status</label>
                                      <select id={`s-${s.id}`} name="status" defaultValue={s.status}><option value="active">Active</option><option value="disabled">Disabled</option></select>
                                      <button className="btn p s" style={{ marginTop: 12 }}>Save</button>
                                    </form>
                                  </div>
                                </details>
                                <details className="pop"><summary>Reset password</summary>
                                  <div className="body">
                                    <form action={resetStaffPasswordAction}>
                                      <FormKeys back={back} /><input type="hidden" name="userId" value={s.id} />
                                      <label htmlFor={`pw-${s.id}`}>New password</label>
                                      <input id={`pw-${s.id}`} name="password" type="password" minLength={8} required autoComplete="new-password" />
                                      <button className="btn s p" style={{ marginTop: 12 }}>Reset</button>
                                    </form>
                                  </div>
                                </details>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grp mt">Add a person</div>
                <form action={createStaffAction} className="grid cols3" style={{ alignItems: 'end' }}>
                  <FormKeys back={back} />
                  <div><label htmlFor="s-name">Name</label><input id="s-name" name="name" required minLength={2} /></div>
                  <div><label htmlFor="s-email">Email</label><input id="s-email" name="email" type="email" required autoComplete="off" /></div>
                  <div><label htmlFor="s-pw">Starting password</label><input id="s-pw" name="password" type="password" required minLength={8} autoComplete="new-password" /></div>
                  <div><label htmlFor="s-role">Role</label><select id="s-role" name="role" defaultValue="cashier">{(['cashier', 'dealer', 'waiter', 'kds'] as const).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></div>
                  <div><label>Works at</label>{scope.outlets.map((x) => <label key={x.id} style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit', fontSize: 14, color: 'var(--ink)', display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0' }}><input type="checkbox" name="outletIds" value={x.id} defaultChecked={x.id === scope.one?.id} style={{ width: 'auto', minHeight: 0 }} />{x.name}</label>)}</div>
                  <div><button className="btn p">Add person</button></div>
                </form>
              </section>
            </>
          );
        }

        // outlets
        const all = await listOutlets(db, ctx);
        const [ow] = await db.select().from(schema.owners).where(eq(schema.owners.id, ctx.ownerId!));
        const open = all.filter((x) => x.status === 'active').length;
        return (
          <>{tabs}
            <section className="card">
              <div className="row sp"><div><h2>Outlets</h2><p className="sub">Each outlet keeps its own wallets, tables, menu and books. Members and cards work at all of them.</p></div><Tag kind={open >= ow.outletLimit ? 'warn' : 'ok'}>{open} of {ow.outletLimit} on your {ow.plan} plan</Tag></div>
              <div className="scroll mt">
                <table className="tbl">
                  <thead><tr><th>Outlet</th><th>Code</th><th>Since</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {all.map((x) => (
                      <tr key={x.id}>
                        <td><b style={{ fontWeight: 600 }}>{x.name}</b></td><td className="num">{x.code}</td><td className="num" style={{ fontSize: 13 }}>{ts(x.createdAt)}</td>
                        <td><Tag kind={statusKind(x.status)}>{x.status}</Tag></td>
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end' }}>
                            <details className="pop"><summary>Rename</summary>
                              <div className="body"><form action={updateOutletAction}><FormKeys back={back} /><input type="hidden" name="outletId" value={x.id} /><label htmlFor={`n-${x.id}`}>Name</label><input id={`n-${x.id}`} name="name" defaultValue={x.name} required /><button className="btn s p" style={{ marginTop: 12 }}>Save</button></form></div>
                            </details>
                            <form action={updateOutletAction}><FormKeys back={back} /><input type="hidden" name="outletId" value={x.id} /><input type="hidden" name="status" value={x.status === 'active' ? 'closed' : 'active'} /><button className={`btn s ${x.status === 'active' ? 'd' : ''}`}>{x.status === 'active' ? 'Close outlet' : 'Reopen'}</button></form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grp mt">Add an outlet</div>
              <form action={createOutletAction} className="row" style={{ alignItems: 'flex-end' }}>
                <FormKeys back={back} />
                <div style={{ width: 240 }}><label htmlFor="o-name">Name</label><input id="o-name" name="name" required minLength={2} /></div>
                <div style={{ width: 120 }}><label htmlFor="o-code">Code</label><input id="o-code" name="code" required maxLength={8} placeholder="BAN" /></div>
                <button className="btn p">Add outlet</button>
              </form>
              {open >= ow.outletLimit && <div className="note">You are at your plan’s limit. Contact DepFlx to add more outlets.</div>}
            </section>
          </>
        );
      }}
    </OwnerShell>
  );
}
