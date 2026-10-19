import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '@/lib/errors';

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));

const { act, messageOf, rupeesToPaise, safeBack, str } = await import('@/lib/act');

async function target(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { url: string }).url;
  }
  throw new Error('did not redirect');
}

describe('safeBack', () => {
  it('only allows same-site paths', () => {
    expect(safeBack('/owner/books?o=all', '/x')).toBe('/owner/books?o=all');
    expect(safeBack('https://evil.test', '/x')).toBe('/x');
    expect(safeBack('//evil.test/path', '/x')).toBe('/x');
    expect(safeBack('javascript:alert(1)', '/x')).toBe('/x');
    expect(safeBack(null, '/x')).toBe('/x');
    expect(safeBack('', '/x')).toBe('/x');
  });
});

describe('messageOf', () => {
  it('shows app errors as written, validation errors by their first issue, and hides anything else', () => {
    expect(messageOf(new AppError('low_balance'))).toBe('Low balance. Please visit the counter to recharge.');
    const bad = z.object({ name: z.string().min(2, 'Enter the full name.') }).safeParse({ name: '' });
    expect(messageOf(bad.error)).toBe('Enter the full name.');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(messageOf(new Error('relation "x" does not exist'))).toBe('Something went wrong. Nothing was changed. Try again.');
    spy.mockRestore();
  });
});

describe('act', () => {
  it('sends the person back with a one-line result', async () => {
    expect(await target(act('/staff/counter?m=1', async () => 'Saved.'))).toBe('/staff/counter?m=1&ok=Saved.');
    expect(await target(act('/staff/counter', async () => undefined))).toBe('/staff/counter');
  });

  it('turns a failure into an error message and replaces any earlier result', async () => {
    const url = await target(act('/owner?ok=old&o=all', async () => {
      throw new AppError('table_full');
    }));
    expect(url).toContain('err=This+table+has+reached+its+8-player+limit.');
    expect(url).not.toContain('ok=old');
    expect(url).toContain('o=all');
  });

  it('can redirect somewhere else on success', async () => {
    expect(await target(act('/login', async () => ({ to: '/owner', msg: 'Welcome.' })))).toBe('/owner?ok=Welcome.');
    expect(await target(act('/login', async () => ({ to: '/kds' })))).toBe('/kds');
  });
});

describe('form helpers', () => {
  it('reads trimmed strings and converts rupees to whole paise', () => {
    const fd = new FormData();
    fd.set('name', '  Ravi  ');
    fd.set('amount', '1499.99');
    fd.set('empty', '');
    expect(str(fd, 'name')).toBe('Ravi');
    expect(str(fd, 'missing')).toBe('');
    expect(rupeesToPaise(fd, 'amount')).toBe(149999);
    expect(rupeesToPaise(fd, 'empty')).toBe(0);
  });
});
