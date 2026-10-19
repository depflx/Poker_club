import { redirect } from 'next/navigation';
import { ZodError } from 'zod';
import { AppError } from './errors';

const enc = encodeURIComponent;

/** Only same-site paths are allowed as a redirect target. */
export function safeBack(raw: FormDataEntryValue | null | undefined, fallback: string): string {
  const s = typeof raw === 'string' ? raw : '';
  return s.startsWith('/') && !s.startsWith('//') ? s : fallback;
}

function withParam(path: string, key: 'ok' | 'err', value: string) {
  const [base, query = ''] = path.split('?');
  const p = new URLSearchParams(query);
  p.delete('ok');
  p.delete('err');
  p.set(key, value);
  return `${base}?${p.toString()}`;
}

export function messageOf(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof ZodError) return e.issues[0]?.message ?? 'Check the form and try again.';
  console.error(e);
  return 'Something went wrong. Nothing was changed. Try again.';
}

/**
 * Runs a server action and sends the person back with a one-line result.
 * redirect() throws, so it stays outside the try block.
 */
export type ActResult = string | void | { to: string; msg?: string };

export async function act(back: string, fn: () => Promise<ActResult>): Promise<never> {
  let target: string;
  try {
    const r = await fn();
    if (r && typeof r === 'object') target = r.msg ? withParam(r.to, 'ok', r.msg) : r.to;
    else target = r ? withParam(back, 'ok', r) : back;
  } catch (e) {
    target = withParam(back, 'err', messageOf(e));
  }
  redirect(target);
}

export const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
export const rupeesToPaise = (fd: FormData, k: string) => Math.round(Number(str(fd, k) || 0) * 100);
export { enc };
