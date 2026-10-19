import type { DB } from '@/db/client';

export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
/** Anything that can run queries: the db itself or an open transaction. */
export type Q = DB | Tx;
