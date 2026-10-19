import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

const MIGRATIONS = path.resolve(process.cwd(), 'drizzle');

/** In-memory (or file-backed) Postgres for tests and local dev. */
export async function createPgliteDb(dataDir?: string): Promise<DB> {
  if (dataDir) fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as DB;
}

const g = globalThis as unknown as { __db?: Promise<DB> };

/** Production uses DATABASE_URL (Postgres). Without it, dev falls back to a local PGlite folder. */
export function getDb(): Promise<DB> {
  g.__db ??= (async () => {
    let db: DB;
    if (process.env.DATABASE_URL) {
      const { Pool } = await import('pg');
      const { drizzle } = await import('drizzle-orm/node-postgres');
      const { migrate } = await import('drizzle-orm/node-postgres/migrator');
      const pg = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema });
      await migrate(pg, { migrationsFolder: MIGRATIONS });
      db = pg as unknown as DB;
    } else {
      db = await createPgliteDb(path.resolve(process.cwd(), '.data/pglite'));
    }
    const { bootstrap } = await import('@/server/bootstrap');
    await bootstrap(db);
    return db;
  })().catch((e) => {
    g.__db = undefined; // do not cache a failed start
    throw e;
  });
  return g.__db;
}
