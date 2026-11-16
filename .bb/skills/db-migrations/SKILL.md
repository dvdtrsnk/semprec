---
name: db-migrations
description: "How a Postgres schema change is written - before the first production release the schema is a baseline edited in place together with the seed; after it, forward-only expand/contract. Plus the rules that always hold: every table declares its tenancy with RLS, unique keys lead with tenant_id, new unique indexes are checked against ON CONFLICT arbiters. Load this BEFORE writing or editing a migration file. Triggers on: backend/packages/data/src/db/migrations/, a NNNN_name.sql file, ALTER TABLE, CREATE TABLE, DROP COLUMN, ADD COLUMN, NOT NULL, DEFAULT, CREATE INDEX, CREATE UNIQUE INDEX, CONSTRAINT, COMMENT ON TABLE, tenant_id, ROW LEVEL SECURITY, CREATE POLICY, a column type change, a rename, ON CONFLICT next to a new unique index, an index drop, the seed, and any data backfill. Skip only when the change touches no schema and no stored data shape."
---

# Migrations

Policy and mechanism: `docs/architecture/migrations-and-seeding.md`.

## Before the first production release: edit the baseline

No production database exists. The migration files are a baseline, not a
history:

- Change the schema by editing the file that defines the table, index, policy
  or function. Do not append an `ALTER` that reshapes something defined earlier.
- Edit the seed and module manifests in the same change, so a fresh database is
  migrated and seeded straight into the target shape.
- Write no cutover, backfill, data conversion, compatibility shim or
  post-migration step for development data; local and test databases are
  recreated.

## After the first production release: forward-only, expand/contract

Rollback flips the release symlink back without unwinding schema, so the
previous release must keep working against the new schema:

- A released migration is never edited or renumbered; every change is a new file.
- One release may add tables, indexes, nullable or defaulted columns, widen a
  type or relax a constraint. Drops, renames, narrowing, `SET NOT NULL` without a
  default are a later *contract* step.
- Backfills are separate from DDL, idempotent, batched and resumable.
- A writer of a new stored value ships after a release whose readers accept it.
- An intentional break needs `-- expand-contract-exemption: <reason>` and an
  issue Task that calls for it.

## Always

**Every table declares its tenancy** in the file that creates it:
`COMMENT ON TABLE <t> IS 'semprec:tenancy=tenant'` (or `global`, only for
identity-plane, admin-plane and operator tables without user content). A tenant
table gets `tenant_id`, RLS and both policies:

```sql
CREATE TABLE widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  -- ... application columns follow, so the comma above is required
);
COMMENT ON TABLE widgets IS 'semprec:tenancy=tenant';
ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON widgets AS RESTRICTIVE
  USING (tenant_id = (SELECT app_tenant_default()))
  WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON widgets AS PERMISSIVE
  USING (true) WITH CHECK (true);
```

- Every unique index, unique constraint or primary key on a tenant table leads
  with `tenant_id`, except a server-generated surrogate key or a key scoped by a
  same-tenant parent's server-generated id. Unique and foreign-key checks ignore
  RLS, so anything else is a cross-tenant existence oracle.
- Grants follow `docs/operations/database-roles.md`.

**Indexes change what existing statements do.** Before adding a unique index,
grep every `INSERT … ON CONFLICT` on the table: an arbiter absorbs conflicts
only on the index it names, any other raises `23505`. Before dropping or
reordering an index, find the queries that rely on its leading columns.

**Ordinals.** Parallel branches can pick the same next ordinal; take it right
before pushing and run `pnpm --filter @semprec/data run check-migration-numbering`
in `backend/`. Renumber only your own unmerged file.
