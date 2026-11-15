---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A SECURITY DEFINER function's search_path ends with pg_temp

## Context

[[2026-09-27-runtime-ddl-through-security-definer-functions]] and
[[2026-10-07-cross-tenant-router-functions]] require every `SECURITY DEFINER` function to pin its
`search_path`, and all of them pinned `pg_catalog, public`. That setting does not name `pg_temp`.
PostgreSQL searches the session's temporary schema first for relation and type names whenever
`pg_temp` is not listed, and every role can create objects there (`PUBLIC` holds `TEMPORARY` on the
database by default).

The external review of gh-1086 (finding R2-DB-1) used this against `create_items_partition(uuid)` and
`drop_items_partition(uuid)`, which are owned by the migrating superuser and use unqualified type
names in their bodies (`partition_name text`, `database_id::text`, and through the nested
`app_current_tenant()` an unqualified `::uuid`). A `semprec_data` session created a domain
`pg_temp.text` whose check called a function it had created in `pg_temp`, then called
`create_items_partition` on a database of its own tenant. The check ran as the owner:
`ALTER ROLE semprec_data SUPERUSER` succeeded. The review did not break the five functions
owned by `semprec_router` (their bodies name no type at run time and qualify every table), but they
carried the same setting and that role is `BYPASSRLS`.

The deploy-time verifier counted any `search_path=` entry of `proconfig` as pinned, so it printed
`tenancy: verified` for the exploitable catalog.

## Decision

Every `SECURITY DEFINER` function in any schema of the database sets `search_path` to `pg_catalog`,
then only schemas in which no runtime role can create objects, then `pg_temp` last. `pg_temp` in the
last position makes the lookup of a relation or type name try the listed schemas before the
temporary schema, so a name that exists in them is never shadowed by one a session creates.

The tenancy verifier (`findDefinerFunctionViolations` in `db/tenancyInvariants.ts`) refuses any
other shape in every schema but `pg_catalog` and `information_schema`, and names the function:

- no `search_path` setting at all;
- the last element is not `pg_temp`, or `pg_temp` is listed more than once;
- `pg_temp` is listed before the end;
- an element that is not an existing schema (`"$user"` included, which resolves per session);
- a listed schema in which `PUBLIC`, `semprec_data` or `semprec_side` holds `CREATE`.

The seven functions that exist (`create_items_partition`, `drop_items_partition`,
`route_graph_subscription`, `route_gmail_address`, `ai_global_spend`, `ops_health_counts`,
`ai_tenant_spend`) were changed by `ALTER FUNCTION ... SET search_path`, which edits `proconfig`
only. A definer function added later sets the same shape in the migration that creates it.

Qualifying type names in function bodies is recommended and is not what the guarantee rests on: the
guarantee is the setting, which the verifier checks at every deploy, and not a property of each body
that a reviewer would have to re-read.

## Alternatives rejected

- **Qualify every type name in every body.** It protects only the bodies someone rewrote and leaves
  the next function to the next author's care. It stays recommended.
- **`REVOKE TEMPORARY ON DATABASE`.** Integration tests create temporary tables themselves, and the
  setting protects the definer functions without changing what sessions may do.

## Consequences

- A definer function created without `pg_temp` last fails the deploy verification, in `public` or in
  any other schema.
- A database in which `PUBLIC` or a runtime role may create objects in `public` (a database
  upgraded from a PostgreSQL release older than 15 and never tightened) fails the verification for
  every definer function whose path lists `public`, until that grant is revoked.
- The previous release calls the seven functions with the same signatures, owners, grants and
  bodies, so a rollback finds the schema it expects.
