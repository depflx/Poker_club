'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { act, str } from '@/lib/act';
import { COOKIE, RETURN_COOKIE, clearSessionCookie, homeFor, requireCtx, setSessionCookie } from '@/lib/session';
import { impersonate, login, logout } from '@/server/auth';

export async function loginAction(fd: FormData) {
  await act('/login', async () => {
    const { token, ctx } = await login(await getDb(), { email: str(fd, 'email'), password: String(fd.get('password') ?? '') });
    await setSessionCookie(token);
    return { to: homeFor(ctx.role) };
  });
}

export async function logoutAction() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await logout(await getDb(), token);
  await clearSessionCookie();
  redirect('/login');
}

/** Superadmin opens an owner's console. The admin's own session is kept so they can step back out. */
export async function impersonateAction(fd: FormData) {
  const ctx = await requireCtx(['superadmin']);
  const jar = await cookies();
  const mine = jar.get(COOKIE)?.value;
  await act('/superadmin', async () => {
    const { token } = await impersonate(await getDb(), ctx, str(fd, 'ownerId'));
    if (mine) jar.set(RETURN_COOKIE, mine, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 3600 });
    await setSessionCookie(token);
    return { to: '/owner' };
  });
}

export async function stopSupportAction() {
  const jar = await cookies();
  const support = jar.get(COOKIE)?.value;
  const back = jar.get(RETURN_COOKIE)?.value;
  if (support) await logout(await getDb(), support);
  jar.delete(RETURN_COOKIE);
  if (back) await setSessionCookie(back);
  redirect(back ? '/superadmin' : '/login');
}
