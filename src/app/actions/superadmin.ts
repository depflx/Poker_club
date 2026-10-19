'use server';

import { getDb } from '@/db/client';
import { act, safeBack, str } from '@/lib/act';
import { requireCtx } from '@/lib/session';
import { createOwner, updateOwner } from '@/server/superadmin';

export async function createOwnerAction(fd: FormData) {
  const ctx = await requireCtx(['superadmin']);
  await act(safeBack(fd.get('_back'), '/superadmin'), async () => {
    const outletName = str(fd, 'outletName');
    const r = await createOwner(await getDb(), ctx, {
      name: str(fd, 'name'),
      plan: str(fd, 'plan') as 'trial' | 'standard' | 'pro',
      outletLimit: Number(str(fd, 'outletLimit') || 1),
      ownerName: str(fd, 'ownerName'),
      ownerEmail: str(fd, 'ownerEmail'),
      password: String(fd.get('password') ?? ''),
      firstOutlet: outletName ? { name: outletName, code: str(fd, 'outletCode') || outletName.slice(0, 3) } : undefined,
    });
    return `${r.owner.name} is set up. Send ${r.ownerUser.email} their password.`;
  });
}

export async function updateOwnerAction(fd: FormData) {
  const ctx = await requireCtx(['superadmin']);
  await act(safeBack(fd.get('_back'), '/superadmin'), async () => {
    const o = await updateOwner(await getDb(), ctx, str(fd, 'ownerId'), {
      plan: str(fd, 'plan') as 'trial' | 'standard' | 'pro',
      outletLimit: Number(str(fd, 'outletLimit')),
    });
    return `${o.name} is on the ${o.plan} plan with room for ${o.outletLimit} outlet${o.outletLimit === 1 ? '' : 's'}.`;
  });
}

export async function setOwnerStatusAction(fd: FormData) {
  const ctx = await requireCtx(['superadmin']);
  await act(safeBack(fd.get('_back'), '/superadmin'), async () => {
    const status = str(fd, 'status') as 'active' | 'suspended';
    const o = await updateOwner(await getDb(), ctx, str(fd, 'ownerId'), { status, reason: str(fd, 'reason') });
    return status === 'suspended' ? `${o.name} is suspended and signed out.` : `${o.name} is active again.`;
  });
}
