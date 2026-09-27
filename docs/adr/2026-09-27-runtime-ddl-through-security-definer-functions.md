---
status: accepted
date: 2026-09-27
area: [backend]
supersedes: []
superseded-by: null
---

# Runtime roles get DDL only through narrow SECURITY DEFINER functions

## Context

[[2026-09-17-two-tier-runtime-database-roles]], as refined by
[[2026-09-22-transcription-worker-choke-point-access]], gives every runtime process a least-privilege
Postgres role: `semprec_data` holds DML on the choke-point tables, `semprec_side` DML on the side
tables, and neither owns a table or holds `CREATE` on schema `public`. Those decisions cover which
role may read and write which rows; they say nothing about DDL.

The choke-point does need one DDL statement at runtime: `databasesStore.createDatabase` creates
each new database's `items` partition (`CREATE TABLE ... PARTITION OF items`) in the same
transaction that inserts its `databases` row (issue #661). Postgres requires `CREATE` on the
schema *and* ownership of the parent table for that statement, so `semprec_data` cannot run it.

The real alternatives:

- **Grant `CREATE` on schema `public` to the runtime role.** Not sufficient on its own (attaching a
  partition still needs ownership of `items`), and it lets the API create any table, function or
  type in the schema — far more than the one statement it needs.
- **Transfer ownership of `items` (or all tables) to the runtime role.** Owners can `ALTER`, `DROP`
  and `TRUNCATE` the table and change its grants; a compromised or buggy API process would hold
  the full schema-changing power the two-tier roles exist to withhold.
- **Create partitions outside the request, from the migrating role** (a separate privileged
  worker or a pre-provisioning step). Breaks the atomicity of "a database row exists if and only
  if its partition does" and adds a process, a queue and a failure mode for one statement.
- **A `SECURITY DEFINER` function owned by the migrating role** that runs exactly that statement,
  callable only by the role that needs it.

## Decision

When a runtime role needs a DDL capability it cannot hold directly, it gets it through a
`SECURITY DEFINER` function created by a migration, of this shape:

- owned by the migrating role (the owner of the objects the DDL touches);
- performs exactly one narrowly parameterised statement, with every identifier and literal escaped
  through `format()` (`%I` / `%L`) and every object reference schema-qualified;
- `SET search_path = pg_catalog, public` pinned on the function, so the definer's privileges cannot
  be redirected to objects in another schema;
- `EXECUTE` revoked from `PUBLIC` and granted only to the one runtime role that needs it.

A schema-level `CREATE` grant or a change of table ownership to a runtime role is never used to
give it DDL. The first such function is `create_items_partition(uuid)`
(`0048_create_items_partition_function.sql`), executable by `semprec_data` only.

## Consequences

- Runtime roles stay DML-only in what they hold directly; every DDL path they can take is
  enumerable by listing `SECURITY DEFINER` functions and their `EXECUTE` grants.
- Each new runtime DDL need costs one new migration adding one function plus its
  `REVOKE`/`GRANT` pair, reviewed like any other privilege change.
- The DDL runs inside the caller's transaction and keeps its locking behaviour (for a partition,
  an `ACCESS EXCLUSIVE` lock on `items` until commit), so atomicity with the surrounding write is
  preserved.
- The function body is security-sensitive code: an unescaped identifier or an unpinned
  `search_path` would hand the definer's privileges to the caller. Review of any such function
  checks both.
- The functions are additive objects, so they fit expand/contract migrations and a rollback to the
  previous release leaves it unaffected.
