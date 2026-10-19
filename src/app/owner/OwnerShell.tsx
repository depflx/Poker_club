import { Shell } from '@/components/Shell';
import { getDb } from '@/db/client';
import { resolveOutlets } from '@/lib/outlet';
import type { Ctx } from '@/lib/permissions';
import { decisionQueue } from '@/server/reports';

interface Props {
  ctx: Ctx;
  current: string;
  title: string;
  eyebrow: string;
  o?: string;
  defaultAll?: boolean;
  surface?: 'floor';
  meta?: React.ReactNode;
  children: (scope: Awaited<ReturnType<typeof resolveOutlets>>) => React.ReactNode;
}

/** Shared frame for every owner page: navigation, outlet switch and the open-decisions badge. */
export async function OwnerShell({ ctx, current, title, eyebrow, o, defaultAll, surface, meta, children }: Props) {
  const scope = await resolveOutlets(ctx, o, { defaultAll });
  const q = await decisionQueue(await getDb(), ctx, scope.isAll ? undefined : scope.selected);
  const open = q.shifts.length + q.pendingPayments.length + q.chipExceptions.length;
  const suffix = o ? `?o=${scope.selected}` : '';
  const nav = [
    { href: '/owner', label: 'Tonight', icon: 'overview', badge: open },
    { href: '/owner/floor', label: 'Floor', icon: 'floor' },
    { href: '/owner/books', label: 'Books', icon: 'money' },
    { href: '/owner/members', label: 'Members', icon: 'members' },
    { href: '/owner/audit', label: 'Audit trail', icon: 'audit' },
    { href: '/owner/settings', label: 'Settings', icon: 'settings' },
  ].map((n) => ({ ...n, href: n.href + suffix }));
  return (
    <Shell
      ctx={ctx} nav={nav} current={current} title={title} eyebrow={eyebrow} brandSub="Owner console" surface={surface}
      outlets={scope.outlets} outletValue={scope.selected} allowAll support={!!ctx.impersonatorId}
      meta={meta ?? <span className="live"><i />{scope.isAll ? 'All outlets' : scope.one?.name}</span>}
    >
      {await children(scope)}
    </Shell>
  );
}
