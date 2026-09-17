# Runtime Postgres roles and least-privilege service connections

Issue #243. Two roles, created by migration `0039_least_privilege_roles.sql`
(`backend/packages/data/src/db/migrations/`):

- **`semprec_data`** — full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the tables the generic
  choke-point (`backend/packages/data/src/chokePoint/*.ts`) writes inside its own
  transactions: `databases`, `properties`, `relation_definitions`, `items`, `item_relations`,
  `views`, `view_items`, `idempotency_keys`, `rollup_dependencies`. It is also a member of
  `semprec_side`, so it inherits full access to every module side table and the queue too —
  necessary because the one process that hosts the choke-point (`semprec-api`) also performs
  its own side-table writes in the same connection pool (its own `process_heartbeats` row,
  mail ingest, doc persistence, the blob-plus-item transaction in `fileUploadStore.ts`).
- **`semprec_side`** — read-only (`SELECT`) on the choke-point tables above, full DML on
  every module side table, and full access to graphile-worker's own `graphile_worker` schema
  (granted by `grantQueueSchemaPrivileges` in `backend/packages/queue/src/index.ts`, called
  once right after `ensureQueueSchema`, since that schema doesn't exist yet at migration time).
  `INSERT`/`UPDATE`/`DELETE` against a choke-point table under this role fails outright — a
  bug that tries to bypass the choke-point from a `semprec_side`-only process is caught by
  Postgres itself.

## Which connection string each service gets

| Service | Role | Why |
|---|---|---|
| `semprec-api` | `semprec_data` | Hosts the choke-point (every `*Handler.ts` route calls `createChokePoint(pool)`). |
| `semprec-ai-gateway` | `semprec_side` | Only ever writes `ai_gateway_calls`, a side table. |
| `semprec-agents` | `semprec_side` | Not yet built; never calls the choke-point directly. |
| `semprec-mailsync` | `semprec_side` | Not yet built; mail ingest writes side tables only. |
| `semprec-transcribe` | `semprec_side` | Not yet built; writes side tables only. |

No service other than `semprec-api` is ever configured with the `semprec_data` connection
string. Each service's `.env.example` documents which role its `DATABASE_URL` must
authenticate as. The actual per-environment connection strings (with real passwords) are
provisioned by issue #175's `shared/.env`, never committed here — the roles created by this
migration have no password until an operator sets one with `ALTER ROLE ... WITH PASSWORD`.

## Extending the grants

Both roles' table lists are maintained by explicit `GRANT` statements in the migration that
introduces a new table — there is no default-privilege rule that grants new tables
automatically, so adding a new choke-point or side table always requires a visible, reviewable
grant change in the same migration. A new table the choke-point writes goes in both the
`semprec_data` (full) and `semprec_side` (`SELECT`-only) grant lists; every other new table
goes only in the `semprec_side` (full) grant list.
