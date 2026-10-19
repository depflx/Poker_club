import { getDb } from '@/db/client';
import { listOutlets } from '@/server/outlets';
import type { Ctx } from './permissions';

export interface OutletScope {
  outlets: { id: string; name: string; code: string }[];
  /** 'all' only when the person has several outlets and asked for the combined view. */
  selected: string;
  /** The outlet to use for pages that work on one outlet at a time. */
  one: { id: string; name: string; code: string } | null;
  /** The outlet ids the page should cover. */
  ids: string[];
  isAll: boolean;
}

/** Works out which outlet(s) a page covers from the ?o= switch, defaulting sensibly. */
export async function resolveOutlets(ctx: Ctx, o?: string, opts: { defaultAll?: boolean } = {}): Promise<OutletScope> {
  const outlets = (await listOutlets(await getDb(), ctx)).filter((x) => x.status === 'active').map(({ id, name, code }) => ({ id, name, code }));
  const wantsAll = o === 'all' || (o === undefined && opts.defaultAll && outlets.length > 1);
  const picked = outlets.find((x) => x.id === o);
  const selected = wantsAll ? 'all' : (picked?.id ?? outlets[0]?.id ?? 'all');
  const isAll = selected === 'all';
  return {
    outlets,
    selected,
    one: isAll ? (outlets[0] ?? null) : (picked ?? outlets[0] ?? null),
    ids: isAll ? outlets.map((x) => x.id) : [selected],
    isAll,
  };
}
