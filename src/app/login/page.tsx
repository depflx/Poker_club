import { redirect } from 'next/navigation';
import { loginAction } from '@/app/actions/auth';
import { currentCtx, homeFor } from '@/lib/session';
import { DEMO } from '@/server/bootstrap';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in · DepFlx Club' };

export default async function LoginPage() {
  const ctx = await currentCtx();
  if (ctx) redirect(homeFor(ctx.role));
  const demo = process.env.DEMO_SEED === '1';
  return (
    <div className="login">
      <div className="panel">
        <div className="brand" style={{ padding: 0 }}>
          <div className="mk" />
          <div>
            <b>DEPFLX</b>
            <small>Club console</small>
          </div>
        </div>
        <h1>Sign in</h1>
        <p className="sub">Use the email and password your club owner gave you.</p>
        <form action={loginAction}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <button className="btn p" style={{ width: '100%', marginTop: 20 }} type="submit">Sign in</button>
        </form>
        {demo && (
          <div className="demo">
            <p style={{ marginBottom: 8 }}>Demo accounts (password shown is for this demo only):</p>
            <p><code>{DEMO.superadmin.email}</code> · <code>{DEMO.superadmin.password}</code> · platform admin</p>
            <p><code>{DEMO.owner.email}</code> · <code>{DEMO.owner.password}</code> · owner</p>
            <p><code>{DEMO.staff.cashier}</code>, <code>{DEMO.staff.dealer}</code>, <code>{DEMO.staff.waiter}</code>, <code>{DEMO.staff.kds}</code> · <code>{DEMO.staff.password}</code></p>
          </div>
        )}
      </div>
    </div>
  );
}
