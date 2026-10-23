---
status: accepted
date: 2026-09-11
area: [backend]
supersedes: []
superseded-by: null
---

# Walk an item's ancestor chain iteratively in the choke-point, not with a recursive CTE

## Context

Issue #241's `GET /api/items/:id?include=path` needs the full breadcrumb from
an item up through every inline database it is nested in: an item's
`databases.parent_item_id` names the item that owns its database, and that
item's own `database_id` names another database that may itself have a
`parent_item_id`, and so on until a top-level database (`parent_item_id
IS NULL`) is reached.

`chokePoint.ts`'s `getItemPath` implements this as a `while` loop inside a
single `withTransaction` call: each iteration re-fetches the current item
(`itemsStore.getItemsByIds`, the same cross-partition-by-id lookup
`findItem` uses) and then its database (`databasesStore.getDatabase`) to
learn the next `parentItemId`, one hop at a time. The alternative — a single
`WITH RECURSIVE` SQL query joining `items` and `databases` — was viable and
would have collapsed the whole walk into one round trip.

## Decision

Keep the iterative, per-level walk rather than switching to a recursive CTE:

- **Missing links stop the walk, they don't fail it.** `getItemPath`'s
  documented contract is to return everything found below the point an
  ancestor's item or database has since gone missing, not to throw. That
  "stop, don't fail" branch is a plain `if (!item) break` per hop in
  application code; expressing the same early-stop-on-missing-row semantics
  inside a recursive CTE (versus a CTE that simply omits the rest of the
  chain, changing what a caller can distinguish) is materially harder to
  read and to change later.
- **Cycle detection is simpler in application code.** A `parent_item_id`
  cycle (database A's owning item lives in database B, whose owning item is,
  transitively, back in database A) must never hang the request. The chosen
  guard is a `Set<string>` of every `databaseId` already visited, breaking
  the moment one repeats — a few lines, easy to unit-test directly (see
  `chokePoint.test.ts`'s `getItemPath` cycle test), and easy to verify by
  inspection. The SQL equivalent needs an explicit anti-cycle array column
  threaded through the recursive term (`WHERE NOT ancestor_ids @> ARRAY[id]`
  or similar) — solving the same problem with more moving parts, in a place
  that is harder for the next reader to unit-test in isolation.
- **The chain is short in practice.** It is bounded by how many levels deep
  a page nests inline databases, which is a handful at most — the N+1
  round-trip cost a recursive CTE would avoid is not a real concern here.

## Consequences

- `getItemPath` costs two round trips per level of nesting instead of one
  query total. Acceptable given the typical chain depth; if a future issue
  needs this to scale to much deeper or much more frequent path lookups,
  that is grounds to revisit this decision, not to add an unrelated
  parallel implementation.
- The cycle guard bounds the loop by the number of distinct databases
  visited, not a separate fixed depth ceiling — because the terminating
  condition is "a database id repeats," not "N hops have elapsed," it stays
  correct however deep a legitimate (acyclic) chain goes.
- Any future hierarchy walk added to the choke-point should default to this
  same shape (per-level fetch, "stop on missing" semantics, visited-set
  cycle guard) rather than introducing a second pattern without a reason
  tied to that walk's own requirements.
