import Link from 'next/link';
import { logoutAction, stopSupportAction } from '@/app/actions/auth';
import type { Ctx } from '@/lib/permissions';
import { Icon } from './Icons';
import { OutletSwitch } from './OutletSwitch';
import { initials } from './ui';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
}

const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Platform admin', owner: 'Owner', cashier: 'Cashier', dealer: 'Dealer', waiter: 'Waiter', kds: 'Kitchen',
};

interface Props {
  ctx: Ctx;
  nav: NavItem[];
  current: string;
  title: string;
  eyebrow: string;
  brandSub: string;
  surface?: 'floor';
  outlets?: { id: string; name: string }[];
  outletValue?: string;
  allowAll?: boolean;
  support?: boolean;
  meta?: React.ReactNode;
  children: React.ReactNode;
}

export function Shell({ ctx, nav, current, title, eyebrow, brandSub, surface, outlets, outletValue, allowAll, support, meta, children }: Props) {
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <div className="mk" />
          <div>
            <b>DEPFLX</b>
            <small>{brandSub}</small>
          </div>
        </div>
        {outlets && outlets.length > 0 && (
          <div className="outlet-switch">
            <OutletSwitch outlets={outlets} value={outletValue ?? outlets[0].id} allowAll={allowAll} />
          </div>
        )}
        <nav className="nav" aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} aria-current={n.href.split('?')[0] === current ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span className="t">{n.label}</span>
              {n.badge ? <span className="badge">{n.badge}</span> : null}
            </Link>
          ))}
        </nav>
        <div className="me">
          <div className="av">{initials(ctx.name)}</div>
          <div>
            <b>{ctx.name}</b>
            <small>{ROLE_LABEL[ctx.role]}</small>
          </div>
          <form action={logoutAction}>
            <button className="linkbtn" type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="stage" data-surface={surface}>
        {support && (
          <div className="support-banner">
            <span>Support session: you are acting as this owner. Everything you do is recorded.</span>
            <form action={stopSupportAction}>
              <button className="btn s" type="submit">Exit support session</button>
            </form>
          </div>
        )}
        <header className="top">
          <div>
            <div className="eyebrow">{eyebrow}</div>
            <h1>{title}</h1>
          </div>
          <div className="meta">{meta}</div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
