---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Atomic collection creation preserves its initial property order

## Context

Gh-1592 requires the properties endpoint to return the title followed by the
supplied property list in input order. Sequential insertion alone does not
deliver this: `propertiesStore` orders reads by key. Batch 07's literal HTTP
example `recipient`, `when`, `status` reproduced alphabetical output instead.
The earlier alphabetically ordered fixture could not distinguish these cases.

Persist only the order that this atomic create operation owns, while retaining
legacy behavior and [[2026-09-10-expand-contract-forward-only-migrations]].

## Decision

Add nullable integer `properties.initial_position`, with no default or backfill
and a check that a non-null value is nonnegative. Existing rows remain null.
This is internal storage; add no property-create/update input, response field
or general reordering operation.

When `createDatabaseWithProperties` creates a database, assign position zero to
its title and positions one through N to supplied entries in input order,
including relation entries. Use the properties owner's store to persist these
positions on the same client and in the same transaction as database, partition
and property creation. Check affected rows. A failure rolls everything back;
the operation retains its single after-commit schema invalidation. No external
work or separate ordering transaction is introduced.

Single-database property reads order by `initial_position ASC NULLS LAST, key`.
Batched property reads group by database and use that same order within each
database. No new index is required for this bounded initial list.

Ordinary property creation leaves the new column null, including properties
added later to an atomically created collection and relation properties. Those
properties follow the positioned initial cohort in alphabetical key order.
An all-null legacy database retains its previous alphabetical order. Creating
a bare database without the `properties` input retains its existing behavior.

Renaming an initially positioned property's key or label does not change its
position. Deleting it leaves a gap. Recreating a property through ordinary
creation produces a null-position tail entry. There is no MAX-plus-one
allocator, renumbering or inference of historical insertion order.

The additive migration retains existing columns, keys, tenancy, RLS and grants.
Previous-release code can continue its explicit reads and inserts against the
new schema; inserts omitting the column leave null. DDL still takes its normal
PostgreSQL locks. This decision promises neither an online migration nor a
measured lock duration.

## Alternatives rejected

- Sequential INSERTs without persisted order: the actual read path sorts by
  key, so the nonalphabetical acceptance example fails.
- Reconstructing historical order from UUIDs or a backfill: existing rows have
  no authoritative insertion order, and their alphabetical behavior must stay.
- Automatically allocating an append position for every ordinary create: adds
  concurrency and ordering policy beyond this initial-list requirement.
- An order field in generic property config or public input: mixes catalog
  presentation metadata into type configuration or introduces an unrequested
  reorder capability.

## Consequences

New atomic collections retain their supplied initial order through the existing
property read endpoints. Subsequent ordinary additions have an explicit
alphabetical-tail policy, rather than an inferred chronological order.

Acceptance must exercise the literal nonalphabetical HTTP example, relation
entries, legacy and later-added properties, rollback and tenant isolation.
Apply the actual migration runner to a populated preceding schema, verify null
positions and preserved legacy order, and exercise previous-release compatible
reads/writes. Fresh-schema tests alone do not prove upgrade compatibility.
