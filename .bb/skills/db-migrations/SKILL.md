---
name: db-migrations
description: "How a Postgres schema change is written - the backend assumes the first version, so the schema is one baseline edited in place together with the seed, with no versions, migrations, backfills or compatibility code. Plus the rules that always hold: every table declares its tenancy with RLS, unique keys lead with tenant_id, new unique indexes are checked against ON CONFLICT arbiters. Load this BEFORE editing the baseline or the seed. Triggers on: backend/packages/data/src/db/migrations/, ALTER TABLE, CREATE TABLE, DROP COLUMN, ADD COLUMN, NOT NULL, DEFAULT, CREATE INDEX, CREATE UNIQUE INDEX, CONSTRAINT, COMMENT ON TABLE, tenant_id, ROW LEVEL SECURITY, CREATE POLICY, a column type change, a rename, ON CONFLICT next to a new unique index, an index drop, the seed, and any wish to backfill or convert stored data. Skip only when the change touches no schema and no stored data shape."
---

# Migrations

Policy and mechanism: `docs/architecture/migrations-and-seeding.md`.

## One baseline, no versions

The backend assumes it is the first version. Every database is created from
`backend/packages/data/src/db/migrations/0001_baseline.sql`; none carries data
from an earlier version:

- Change the schema by editing the statement in the baseline that defines the
  table, index, policy or function. Add no second migration file and append no
  `ALTER` that reshapes something defined earlier.
- Edit the seed and module manifests in the same change, so a fresh database is
  migrated and seeded straight into the target shape.
- Write no backfill, data cutover, data conversion, reconcile of already seeded
  tenants, compatibility shim or reader branch for an older data shape. Local,
  test and deployed databases are recreated from the baseline.
- Production rules (versioned migrations of a database that keeps its data)
  arrive with the owner's first production deployment, as a separate change.

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
