---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Page operations follow the grant on the database that owns the page

## Context

[[2026-10-28-page-operation-family]] classified the page operations under two capabilities of their own,
`core.page.read` and `core.page.write`, and left the agent policy to the page-write policy
([[2026-10-29-agent-page-write-policy]]) and to issue #1844. [[2026-11-06-page-capability-registration-does-not-grant-project-agents]]
kept both ids out of the permission manifest of every project, so no project agent could discover or call a page
operation, and asked #1844 to reconcile that default. Since then [[2026-11-12-per-database-agent-grants]] decides,
per project and database, what an agent may read and write; it lists the page operations among the paths it does
not yet cover. [[2026-11-12-page-replace-takes-the-etag-and-trashes-vanished-subpages]] made `page.replace`
REST-only until the approval of page operations exists.

## Decision

**The page operations hold the item capabilities.** `page.get` and `page.changes` require `core.item.read`; `page.ensure`,
`page.createSubpage`, `page.duplicate`, `page.rename`, `page.insert`, `page.replace` and `page.restoreVersion` require
`core.item.write`. This replaces the capability column of the table in section 3 of the page operation family for
every operation of the family and leaves the rest of that record, including its approval column, as it was. The
reason given there for separate ids, that a grant of `core.item.write` should not allow rewriting pages, is now served
by the per-database grant: what an agent may write is decided by the project's access to the database that owns the
page, which a capability, a property of a run, cannot express. `core.page.read` and `core.page.write` stay registered
and no operation requires them; the manifest exclusion of the 2026-11-06 record is untouched and now has no
operation behind it.

**The database that owns a page** is found by `resolvePageOwnerDatabase(client, itemId)`:

- the page of an item belongs to the item's own database, a Journal day to the Journal database;
- a subpage, an item of the hidden Pages database, belongs to its root host: the walk follows `parentItemId` through
  Pages items, trashed ones included, and answers the database of the first item that is not a Pages item;
- an item or an ancestor that does not exist is a not found, so a page whose host was purged is closed to an agent;
  a stored cycle or a chain of more than 1000 pages is a `ValidationError` ([[2026-11-09-subpage-parent-chains-are-bounded-while-walked]]
  names the same bound for the other two walks).

**An agent's access is checked in the data layer, in the transaction of the operation.** `assertAgentPageAccess` resolves
the owning database and calls `assertAgentDatabaseAccess`, so the decision of [[2026-11-12-per-database-agent-grants]]
applies unchanged: a sensitive database is closed to a project without a grant, a user-created database is open
unless a row says otherwise, a non-sensitive system database is always open. Reads need `read` and writes `write`.
A person, the system and an `/mcp` call on a human session carry no `agentProjectItemId` and are not checked. The
document store takes the project as a trailing parameter of each page read and write the application service calls,
and `replacePageMarkdown` reads it from its writer. The restore is checked by its approval projection, at the call and
again when the approved request is executed, because an agent's restore is always held for approval first.

**An agent's `page.replace` and `page.restoreVersion` are held for approval.** Both are destructive operations whose
request is projected and revalidated by the module that owns the resource, as the restore already was. The replace
snapshot (kind `page_replace`) holds the item id, the document id and the version token the replace was requested
against; the projection also rehearses the replace's refusals, so a stale `expectedEtag` (409), invalid Markdown or a
link to a page that is not a live subpage (400) answer at the call and create no request. At execution the snapshot is
computed again: a page edited since, or a project whose write access was revoked since, ends the request as a conflict
without writing. An approved replace is authored `user`, the approver's decision, as the restore is
([[2026-10-29-agent-page-write-policy]], decision 4). `page.replace` is no longer REST-only. The approval description
key is `approval.pageReplace`.

## Alternatives considered

- A grant check in the gateway before the call: rejected by [[2026-09-17-generic-application-service-port]] and
  [[2026-11-12-per-database-agent-grants]], since it is a pre-check outside the transaction of the write.
- Keeping the page capabilities and granting them per project: rejected, because the per-database grant already
  decides the same question per data owner, and a second grant surface (the 2026-11-06 record declined to add one)
  would have to be kept in step with it.
- Resolving a subpage to the Pages database: rejected, since that database is a hidden system database that is always
  open and would make every subpage writable for every project.

## Consequences

- A project agent now discovers and calls the page operations; what it may touch is what its grants allow. A project
  without a decision on a user-created database keeps today's access.
- A grant row cannot restrict an open system database such as Journal ([[2026-11-12-per-database-agent-grants]]); the Journal
  is restricted for pages only if the database is marked sensitive, after which the grant on it decides.
- `page.changes` checks the access in its lookup transaction and replays the history in a separate snapshot
  transaction, so a revoke that commits between the two is not seen by that one read.
- The breadcrumbs of `page.get` are read from the item path, which can leave the page's database through
  `parentItemId` of a nested database into a database the project may not read. For an agent such an ancestor is
  returned as `{ itemId, title: "", databaseKey: null, hidden: true }`, the way a relation target in an unreadable
  database is hidden ([[2026-11-12-per-database-agent-grants]]): an item title is item content, unlike the schema
  and counts of other databases, which are not filtered.
- The web catalog of approval descriptions has no `approval.pageReplace` entry yet; the backend notification catalogs
  in English and Czech have.
