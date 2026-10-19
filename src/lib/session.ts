import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { loadCtx } from '@/server/auth';
import type { Ctx, Role } from './permissions';

export const COOKIE = 'dfx_session';
export const RETURN_COOKIE = 'dfx_return';

export const homeFor = (role: Role) =>
  ({ superadmin: '/superadmin', owner: '/owner', cashier: '/staff', dealer: '/staff', waiter: '/staff', kds: '/kds' })[role];

export async function currentCtx(): Promise<Ctx | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return loadCtx(await getDb(), token);
}

/** Gate for pages and actions: signed in, and one of the given roles. Otherwise bounce to sign-in or the person's own home. */
export async function requireCtx(roles?: readonly Role[]): Promise<Ctx> {
  const ctx = await currentCtx();
  if (!ctx) redirect('/login');
  if (roles && !roles.includes(ctx.role)) redirect(homeFor(ctx.role));
  return ctx;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 12 * 3600,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(RETURN_COOKIE);
}
