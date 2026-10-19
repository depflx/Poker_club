import { Shell } from '@/components/Shell';
import { resolveOutlets, type OutletScope } from '@/lib/outlet';
import type { Ctx } from '@/lib/permissions';

const NAV: Record<string, { href: string; label: string; icon: string }[]> = {
  cashier: [
    { href: '/staff/counter', label: 'Counter', icon: 'counter' },
    { href: '/staff/shift', label: 'My shift', icon: 'money' },
  ],
  dealer: [{ href: '/staff/floor', label: 'Tables', icon: 'floor' }],
  waiter: [{ href: '/staff/order', label: 'Food order', icon: 'order' }],
};

interface Props {
  ctx: Ctx;
  current: string;
  title: string;
  eyebrow: string;
  o?: string;
  surface?: 'floor';
  children: (scope: OutletScope) => React.ReactNode | Promise<React.ReactNode>;
}

/** Shared frame for cashier, dealer and waiter pages. People with one outlet get no switcher. */
export async function StaffShell({ ctx, current, title, eyebrow, o, surface, children }: Props) {
  const scope = await resolveOutlets(ctx, o);
  const suffix = o ? `?o=${scope.selected}` : '';
  const nav = (NAV[ctx.role] ?? []).map((n) => ({ ...n, href: n.href + suffix }));
  return (
    <Shell
      ctx={ctx} nav={nav} current={current} title={title} eyebrow={eyebrow} brandSub="Staff" surface={surface}
      outlets={scope.outlets.length > 1 ? scope.outlets : undefined} outletValue={scope.selected}
      meta={<span className="live"><i />{scope.one?.name ?? 'No outlet assigned'}</span>}
    >
      {scope.one ? await children(scope) : <div className="card"><h2>No outlet assigned</h2><p className="sub">Ask the owner to assign you to an outlet.</p></div>}
    </Shell>
  );
}
