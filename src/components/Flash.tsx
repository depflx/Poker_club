'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/** Shows the one-line result of the last action, then clears it from the address bar. */
export function Flash() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ok = params.get('ok');
    const err = params.get('err');
    if (!ok && !err) return;
    // State is set from a timer callback, not the effect body, so it never cascades a render.
    setTimeout(() => setMsg({ text: (ok ?? err)!, err: !!err }), 0);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => setMsg(null), 4500);
    const next = new URLSearchParams(params.toString());
    next.delete('ok');
    next.delete('err');
    const q = next.toString();
    router.replace(q ? `${path}?${q}` : path, { scroll: false });
  }, [params, path, router]);

  if (!msg) return null;
  return (
    <div className={`flash ${msg.err ? 'err' : ''}`} role={msg.err ? 'alert' : 'status'}>
      {msg.text}
    </div>
  );
}
