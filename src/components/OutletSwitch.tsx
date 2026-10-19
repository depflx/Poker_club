'use client';

import { usePathname, useRouter } from 'next/navigation';

export function OutletSwitch({ outlets, value, allowAll }: { outlets: { id: string; name: string }[]; value: string; allowAll?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  return (
    <>
      <label htmlFor="outlet-select">Outlet</label>
      <select id="outlet-select" value={value} onChange={(e) => router.push(`${path}?o=${e.target.value}`)}>
        {allowAll && outlets.length > 1 && <option value="all">All outlets</option>}
        {outlets.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </>
  );
}
