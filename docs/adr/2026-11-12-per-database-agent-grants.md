---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# An agent's access to a database is checked in the data layer, per project and database

## Context

An agent run holds all of the core capabilities (`core.database|item|schema|view.read|write`) for every database of
the tenant. The gateway decides by capability only (`isGranted` in `genericOperationGateway.ts`), the generic
application service ignores the actor on reads, and a non-destructive write runs without approval
([[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]]). Issue #1808 marked the databases that hold
health and sleep data as `sensitive`. Nothing yet keeps an agent out of them, and the user cannot switch a
user-created database off for one project.

[[2026-09-17-generic-application-service-port]] forbids splitting a protected write into a pre-check in the gateway
and a separate write, and the repository rule on guards says a check outside the transaction of the write it protects
is not a guard. The writer of a choke-point write now carries the agent's project (`WriterIdentity.agentProjectItemId`,
issue #1415), which a person and the system do not.

## Decision

**Access is a property of a project and a database.** The table `agent_database_grants` holds one row per tenant,
project item and database with an access of `none`, `read` or `write`; `write` includes `read` and `none` denies both.
Without a row: a sensitive database is `none`, a user-created database is `write`, and a non-sensitive system
database is always open and never has a row (a row that exists for one is ignored). A user switching a user-created
database off for a project stores `none`, after which it is denied like a sensitive database without a grant. Grants
apply to the project of the run. Besides the cleanup below, only the admin store
(`agentDatabaseGrantsAdminStore.ts`) writes them. It is not exported from the package barrel, so agent code has no
path to it; the user-only routes of issue #1841 will call it.

**The check is in the data layer, in the transaction of the read or write it guards.**
`assertAgentDatabaseAccess` reads the database row and the project's stored decision in one statement and locks that
decision row `FOR SHARE`. It answers `ForbiddenError` (403 `forbidden`) with a message and details that name the
database and the required access and no content of any item, and `NotFoundError` for a database the tenant does not
have. It runs before the read or write on these paths, for a writer or reader that carries an `agentProjectItemId`:

- item get, item list and database or view query, by the database of the item or the query; the relation targets of
  such a read that lie in a database the project may not read are returned as `{ id, hidden: true }` and nothing else,
  at the top level of an expansion and inside a projected relation property;
- the relation list, by the database of the listed item; an edge to an item in a database the project may not read is
  listed as its own property and the target's id marked `hidden: true`, without the target's database and the edge's
  metadata;
- item create (also an idempotent replay), patch, delete and restore, by the database of the item; a delete or restore
  also checks every other database its cascade reaches;
- relation put, update, set and delete, for both endpoint databases;
- link unlink and relink, by the database of the item whose link changes, before anything about the link is read;
- `database.get`, which is refused, `database.list` and the schema projection, which leave the unreadable databases out;
  a curated view, which has no database, leaves the items of unreadable databases out of its page, its cursor and its
  count, so none of them says how many members of a closed database the view holds.

A person, the system and an `/mcp` call on a human session carry no `agentProjectItemId` and are not checked here. The
denial of sensitive databases to external AI clients on a human token is issue #1998, built on this check. Paths added
later (search, related items, facets, page operations, aggregations) call the check or the list of unreadable
databases themselves; this decision does not cover them.

**The lock is a share lock on the decision row.** A revoke that updates an existing row waits for the transactions
that passed the check on it, and a check that starts after the revoke commits sees `none`. Where no row exists the
default applies and there is nothing to lock: the first row a user stores for such a database (for example `none` for
a user-created database) is not held back by a write that already passed the check, and that write commits. The check
therefore makes a revoke of an existing decision wait, not every revoke.

**Purging a Projects item deletes its decisions** with the item's other dependent rows (`deleteItemDependents`), since
`items` is partitioned and no foreign key can do it. The row names its database with a tenant-composite foreign key.
This is a direct call in `itemTrash.ts`, not an item purge hook ([[2026-11-10-item-purge-domain-hooks]]), because the
issue's task places it there and because the decision row is not a domain's data: it belongs to the choke point's own
authorization check, as the item rows and relation edges that `deleteItemDependents` already removes belong to the choke
point. For the same reason `agentGrants/` is not a domain folder of the `chokepoint-knows-no-domain` and
`item-trash-domain-imports-are-purge-only` dependency rules: the choke point's reads and writes call it all over. A
domain's own cleanup after a purge still registers a purge hook.

**Alternatives rejected.** A pre-check in the gateway followed by the write is the pattern
[[2026-09-17-generic-application-service-port]] forbids, and it leaves a window in which a revoke is not seen.
A capability id per database would multiply the closed capability set by the number of databases, including those
users create, and a capability is a property of a run, not of a project.

## Consequences

- Every path listed in the Decision passes one check. A path it does not list (counts, facets, page operations, search
  and the other later paths named above) is not covered: it must call the check or the list of unreadable databases
  before it is exposed to an agent, or it is a leak.
- A read-only grant lets an agent read and refuses its writes; a relation between two databases needs `write` on both.
- `item.delete`, `relation.delete` and `link.unlink` are checked when the agent asks for approval, in the projection
  that also revalidates the request when it is executed, so a refused one creates no request and a request whose grant
  was revoked in the meantime ends as a conflict without writing. The projection of an `item.delete` also checks every
  other database the delete's cascade reaches, as the write does. The write functions the approved executor then calls
  check again with the agent's writer; the flagged `item.patch`, `relation.put` and `relation.set` reach the check in
  their write before they ask for approval.
- `database.get` of a hidden database is `forbidden`, not `not found`, so an agent can tell that such a database
  exists; an item of a hidden database that does not exist is still `not found` on the paths that look the item up
  first.
- Counts, facets and the schema of a hidden database's properties are not filtered by this decision.
