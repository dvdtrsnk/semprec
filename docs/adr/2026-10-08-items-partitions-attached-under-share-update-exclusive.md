---
status: accepted
date: 2026-10-08
area: [backend]
supersedes: []
superseded-by: null
---

# Items partitions are attached under SHARE UPDATE EXCLUSIVE

## Context

[[2026-09-27-runtime-ddl-through-security-definer-functions]] has the API role create each
database's `items` partition through `create_items_partition(uuid)`, and records that the DDL keeps
its locking behaviour: `CREATE TABLE ... PARTITION OF` takes an `ACCESS EXCLUSIVE` lock on `items`
until the caller commits. `items` is shared by every tenant, so while one user creates a database,
or a tenant is provisioned with its couple of dozen system databases, every other tenant's item
reads and writes queue behind that transaction. That couples tenants' availability and leaks a
timing signal across them.

## Decision

`create_items_partition` creates the partition as a standalone table
(`LIKE public.items INCLUDING ALL EXCLUDING INDEXES EXCLUDING COMMENTS`) and then runs
`ALTER TABLE public.items ATTACH PARTITION ... FOR VALUES IN (<id>)`. The attach takes
`SHARE UPDATE EXCLUSIVE` on `items`, which conflicts with neither `ACCESS SHARE` nor
`ROW EXCLUSIVE`, and `ACCESS EXCLUSIVE` only on the new empty table, so it needs no scan. Indexes
and foreign keys come from the attach, as with `PARTITION OF`. Cloning the `database_id` foreign key
onto the partition takes `SHARE ROW EXCLUSIVE` on `databases` until the caller commits, exactly as
`PARTITION OF` did; this decision does not change that lock. Signature, owner, `search_path`,
partition name, tenant guard and grants are unchanged.

This narrows only the lock consequence of the earlier decision; the delegation of runtime DDL to
`SECURITY DEFINER` functions stands.

## Consequences

- Item reads and writes of other tenants no longer wait on partition creation. This holds for
  `items` only.
- Writes to `databases` still couple tenants. `databases` is shared by every tenant, and the
  `SHARE ROW EXCLUSIVE` lock taken by the cloned `database_id` foreign key conflicts with
  `ROW EXCLUSIVE`, so every other tenant's `INSERT`, `UPDATE` and `DELETE` on `databases` —
  including creating a database of their own — waits until a partition creation commits. The
  availability coupling and timing signal from the Context therefore remain on `databases`; reads
  of `databases` are unaffected.
- Concurrent partition creations still serialize: `SHARE UPDATE EXCLUSIVE` conflicts with itself,
  so a second creation waits for the first transaction to finish.
- The partition must stay catalog-equivalent to a `PARTITION OF` one; a test compares the two.

## Alternatives considered

- **Keep `PARTITION OF` and pre-create partitions in bulk.** Rejected: it still takes the
  `ACCESS EXCLUSIVE` lock, only less often and in larger blocks, and it needs a pool of
  unassigned partitions bound to ids that do not exist yet.
