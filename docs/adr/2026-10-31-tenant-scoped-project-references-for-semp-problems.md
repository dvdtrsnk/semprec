---
status: proposed
date: 2026-10-31
area: [backend]
supersedes: []
superseded-by: null
---

# Tenant-scoped project references for Semp problems

## Context

`items` is partitioned by database and its primary key includes `database_id`
(see `0001_core_schema.sql`). A problem stores a project item id without that
partition key, so Postgres cannot enforce the reference with a two-column tenant
foreign key. Adding a database id would change the stored shape. Tenant
isolation remains governed by [[2026-10-03-tenant-isolation-through-row-level-security]].

## Decision

Before `raiseProblem` inserts or merges a problem with a project reference, it
validates the UUID and checks the current tenant's system Projects database in
the conditional INSERT/UPSERT itself. Missing, foreign and wrong-database
references receive the same validation error. No lookup bypasses tenant scope.
A missing reference is allowed. This scoped exception to the usual row-lock
guidance keeps the existing side role's read-only access to items; a separate
pre-check would not establish the write's own snapshot condition.

## Consequences

The statement checks attribution against its MVCC snapshot; it does not lock the
project or guarantee its existence at commit. A concurrent or later project
deletion can leave a historical reference. This is not a database foreign key. The problem and its notification are
not written when the guard rejects the reference.
