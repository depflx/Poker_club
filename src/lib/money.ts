/** Money is whole paise everywhere in the server. */
export const rupees = (n: number) => Math.round(n * 100);

export function formatINR(paise: number): string {
  const sign = paise < 0 ? '−' : '';
  const abs = Math.abs(paise) / 100;
  return `${sign}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function assertAmount(n: unknown, label = 'Amount'): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive whole number of paise`);
  return n;
}
