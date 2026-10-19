import { randomUUID } from 'node:crypto';
import { formatINR } from '@/lib/money';

export const inr = formatINR;
export const initials = (name: string) => name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();

export function Tier({ tier }: { tier: string }) {
  return <i className={`tier t-${tier}`} title={tier} role="img" aria-label={`${tier} tier`} />;
}

type Kind = 'ok' | 'bad' | 'warn' | 'info' | '';

export function Tag({ kind = '', children }: { kind?: Kind; children: React.ReactNode }) {
  return <span className={`tag ${kind}`}>{children}</span>;
}

const KINDS: Record<string, Kind> = {
  active: 'ok', confirmed: 'ok', approved: 'ok', completed: 'ok', served: 'ok', paid_wallet: 'ok', in_progress: 'ok',
  lost: 'bad', failed: 'bad', cancelled: 'bad', closed: 'bad', disabled: 'bad',
  suspended: 'warn', pending: 'warn', review: 'warn', replaced: 'warn', damaged: 'warn', pending_settlement: 'warn',
  preparing: 'info', ready: 'info',
};
export const statusKind = (s: string): Kind => KINDS[s] ?? '';

/** Hidden fields every mutating form carries: where to come back to, and a key that makes a double submit harmless. */
export function FormKeys({ back }: { back: string }) {
  return (
    <>
      <input type="hidden" name="_back" value={back} />
      <input type="hidden" name="_key" value={randomUUID()} />
    </>
  );
}

export function Money({ name, defaultValue, required, min = 0 }: { name: string; defaultValue?: number; required?: boolean; min?: number }) {
  return (
    <label className="money-in" style={{ margin: 0 }}>
      <span className="num">₹</span>
      <input name={name} type="number" step="0.01" min={min} defaultValue={defaultValue} required={required} aria-label={name} />
    </label>
  );
}

const DEN: [number, string][] = [
  [500000, '#1C1E22'], [250000, '#2E8A62'], [100000, '#2F5FC4'], [50000, '#C4412F'], [10000, '#ECE8DC'],
];

/** Chip stacks drawn in casino denominations (₹100, 500, 1,000, 2,500, 5,000). */
export function ChipStacks({ paise }: { paise: number }) {
  let rest = paise;
  const stacks: { c: string; n: number }[] = [];
  for (const [d, c] of DEN) {
    const n = Math.floor(rest / d);
    rest %= d;
    if (n) stacks.push({ c, n: Math.min(n, 6) });
  }
  return (
    <>
      {stacks.map((s) => (
        <div className="stk" key={s.c} style={{ '--c': s.c } as React.CSSProperties}>
          {Array.from({ length: s.n }, (_, i) => <i className="ch" key={i} />)}
        </div>
      ))}
    </>
  );
}

export const ts = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
