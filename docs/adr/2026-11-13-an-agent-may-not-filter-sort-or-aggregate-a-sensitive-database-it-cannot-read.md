---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# An agent may not filter, sort or aggregate a sensitive database it cannot read

## Context

[[2026-11-12-per-database-agent-grants]] refuses an agent project the items of a sensitive database it holds no grant
on and returns a relation target in such a database as `{ id, hidden: true }`. The agent can still learn about the
records indirectly from a database it may read: a `relation_contains` filter over a relation into Health records
answers "which projects are linked to record X", a `relation_is_not_empty` filter or a sort by a rollup tells how many
records a project has, and a rollup that counts or sums the records exposes that number on a readable item, without any
sensitive item being returned. The product owner decided that filters and aggregations over a sensitive database are
closed for an agent without read access to it, because the sensitivity belongs to the data, not to the way it is asked
for.

## Decision

**The closed databases of a project are the sensitive databases its access is `none` on.** `listClosedSensitiveDatabaseIds`
(`agentGrants/agentDatabaseAccess.ts`) decides them with the same SQL expression as the point check, so the two cannot
disagree. A database that is not sensitive is never closed here, an explicit `none` decision for a user-created database
included: that database is guarded by the point check of its own items and by [[2026-11-12-per-database-agent-grants]],
not by this decision. The set is read in the transaction of the guarded read and is not locked.

**The filter compiler refuses with a `ForbiddenError` (`forbidden`, 403).** `compileFilterNode` takes the closed set and
refuses, whatever the operator and however deep the condition sits under `and`, `or` and `not`, a condition on a
relation property whose target database is closed (`relation_contains`, `relation_not_contains`, `relation_is_empty`,
`relation_is_not_empty`), a `relation_path_contains` whose first or second hop reaches a closed database, and any
condition on a rollup whose source database is closed. The source database of a rollup is the one recorded in
`rollup_dependencies.source_database_id`, which the recompute worker aggregates by. The message and the details name the
property key and the database id, never an item or a value.

**A grouping and a facet are refused the same way.** An `item.count` entry whose `groupBy` is a relation property into a
closed database would list that database's record ids with a count each, and `database.facets` would count by the same
filters and list the records a relation or a path facet reaches, so both refuse: the `groupBy`, the filter and
`extra.open` of a facet call, and a relation facet or a path facet whose first or second hop reaches a closed database.

**A sort by such a rollup is refused the same way,** in a request's `sort` and in a stored view's `sort` and `groupBy`
(`assertNoSortOverClosedRollup`). A stored view whose own filter or sort reaches a closed database is therefore refused
to the agent, and open again once the project holds a grant.

**The value of such a rollup is hidden.** Every rollup of an item whose source database is closed is read as
`{ value: null, hidden: true }` in `computed`, whether or not the item has a computed value for it, so a missing value
says nothing either (`hideClosedRollupValues`). It applies to `getItem`, `findItem`, `listItems`, `database.query` and
`view.query`, a curated view's page included, and to the item a write returns to its agent writer (`item.create`,
`item.patch`, `item.delete`, `item.restore` and the current item a version conflict carries), because that response
holds the same `computed`. The stored value is unchanged, and a person reads the plain number.

**The checks run for an agent's project only, on the paths that name it.** `database.query`, `view.query` and the choke
point's `listItems` take the closed set from their `reader`; `item.count` and `database.facets` take it from
`CountItemsBatchOptions.agentProjectItemId` and `DatabaseFacetsOptions.agentProjectItemId`, which the application layer
sets from the run credential and which do not decide the access to the counted or faceted database; a write takes it
from its writer identity.
A person, the system and an external AI client on `/mcp` ([[2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases]])
are passed no closed set and are not touched; the external client is refused a sensitive database by the database alone.

## Consequences

- A project that has `read` or `write` on the sensitive database filters, sorts and reads the rollups as before; with no
  grant, the refusal does not depend on whether the filter would have matched anything.
- `buildFilterProperties` reads the source databases of the rollups of the queried database in one extra query (none
  when it has no rollup), for every caller, so the query also runs for a person. The target database of a path's second
  hop comes with the query it already made for that hop.
- Not covered by this decision: the count and the facets of a closed database itself, search and related items, and the
  non-service `chokePoint.queryView`. A path added later that filters, sorts, groups or aggregates for an agent passes the
  closed set to `compileFilterNode` and the rollup hiding itself, or it is a leak.
