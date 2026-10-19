# DepFlx Club

Poker club operations for an owner with one or more outlets: members, NFC cards, wallet, floor, kitchen.

Five modules in one Next.js app, all built from the PRD and the owner design:

| Module | Who | Where |
|---|---|---|
| Superadmin | DepFlx platform operator | `/superadmin` owners, plans, outlet limits, suspend, support sessions, platform audit |
| Owner | Club owner | `/owner` tonight, floor, books, members, audit trail, settings (rules, menu, tables, staff, outlets) |
| Staff | Cashier, dealer, waiter | `/staff` counter + shift, tables, food order |
| KDS | Kitchen | `/kds` full-screen board, refreshes by itself |
| Multi-outlet | Owner and staff | outlet switcher and an "All outlets" roll-up; one member profile, one wallet per outlet |

## Run it

```bash
npm install
npm run dev          # http://localhost:3100, demo data loads on first start (DEMO_SEED=1 in .env.local)
npm test             # 238 tests
npm run lint
npm run typecheck
npm run build
```

Demo accounts (demo data only): `admin@depflx.test` / `Admin#12345` · `owner@demo.club` / `Owner#12345` ·
`cashier@`, `dealer@`, `waiter@`, `kds@demo.club` / `Staff#12345`.

Without `DATABASE_URL` the app uses an embedded Postgres (PGlite) stored in `.data/`. For production set
`DATABASE_URL` to a Postgres connection string, `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD` for the first admin, and leave `DEMO_SEED` unset.

## How it is built

- `src/server/*` holds every business rule as a function that takes the signed-in person's context. Pages and server actions call these and nothing else. Permissions are checked there, not in the screens.
- `src/db/schema.ts` and `drizzle/*.sql` hold the rules the database enforces on its own: eight seats at most, one seat per player, one active card per member, no negative wallet, append-only ledger, audit trail, chip log and round corrections.
- Money is whole paise. Every money and chip write is one transaction with an idempotency key.
- `tests/*.test.ts` run against a real in-process Postgres, one file per module plus permission, bootstrap and helper tests.

## Known limits

- The concurrency tests run on PGlite, which has a single connection, so competing requests are serialised. They prove the database constraints and the idempotency keys. A load test against a real multi-connection Postgres is still to do before launch.
- Tap-to-read uses Web NFC, which works only in Chrome on Android. Elsewhere the card ID is typed. A static card ID can be cloned; use NTAG 424 DNA cards if that matters.
- UPI is confirmed by staff with a reference. There is no payment gateway yet.
- Cash-out of wallet balances is not built and cannot be switched on. It needs legal and compliance sign-off.
- Adjustments above the outlet threshold need a second owner account. There is no screen yet to add a second owner login.
- Fonts download from Google at build time.
