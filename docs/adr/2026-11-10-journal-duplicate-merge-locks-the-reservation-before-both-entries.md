---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# A Journal duplicate merge takes the period reservation before both entries and leaves each system-owned edge to its owner

## Context

Nothing makes a Journal entry's `type` and `period` unique. [[2026-11-08-journal-restore-serializes-on-its-period-reservation]]
stops a restore from adding a second live entry, but periods with two live entries exist from earlier data. Issue #1726
adds `mergeJournalDuplicates(client, { periodType, period })` (`journal/mergeJournalDuplicates.ts`): the entry created
first survives, the other one's page content and relation edges go to it, and the other one is moved to the Trash, in
the caller's transaction. An approval-gated operation (#2017) will call it; this function has no approval gate of its
own.

Four things made a decision necessary:

- The period reservation (`idempotency_keys` row `journal:<journalDatabaseId>:<type>:<period>`) can point at the entry
  that is merged away. `insertItemWithReplay` treats a reservation of a trashed item as free, so the next
  `getOrCreateJournalItem` would create a third entry beside the survivor. The reservation ADR above lets the Journal
  module write that row for the restore only.
- A merge moves state of other owners ([[2026-09-10-single-writer-ownership-model]]): the Journal `events` relation is
  owned by the `journalEventLinks` process, which derives it from the page (`syncJournalEventLinks`), and the Inbox
  `journalDay` relation and each day's cached Inbox list are owned by the Inbox process. The choke point refuses a
  write of either relation without its owner's context.
- Some edges a duplicate holds cannot be created on the survivor, because the choke point refuses them: an edge to an
  item in the Trash, and a Journal `area` while the survivor has a live project (`assertNotDerivedValueWrite`).
- `insertPageMarkdown`, the page insertion issue #1726 names, refuses a subpage link and a link to an item that is not
  live.

## Decision

- **One pair per call.** A call merges the two live entries of the period that were created first, ordered by
  `created_at` and then `id`; the older one survives. It returns `null` when the period has fewer than two. It refuses a
  client that is not the one of the caller's `withTransaction` (`requireManagedTransaction`), so its steps cannot commit
  one by one.
- **Lock order** (`lockJournalDuplicatePair`, `journal/journalStore.ts`): a plain read finds the pair and returns
  `null` before anything is locked or written when there is none. Then the reservation row is taken with the statement
  the restore uses (`INSERT … ON CONFLICT (tenant_id, key) DO UPDATE` that changes no value; it inserts the row for the
  older entry when it is missing). Holding it, the same read runs again with `FOR UPDATE` and row-locks both entries;
  fewer than two rows returns `null`. Last, the reservation is updated to the survivor. This is the second purpose the
  Journal module writes that reservation row for; the key and the module are the ones of the restore.
- **Page.** The duplicate's page is read as canonical Markdown and appended with `insertPageMarkdown`, placement `end`,
  origin `system`. Its first block is left out when it is a heading and the survivor's page starts with a heading of
  the same level and the same inline content. The duplicate keeps its own page. Whatever the insertion refuses fails the
  merge with the insertion's error.
- **Edges move through the choke point, the system-owned ones through their owners.**
  - `moveRelationEdgesWithClient` (`chokePoint/relationOps.ts`) moves the edges of one relation property from one item
    to another by `deleteRelationWithClient` and `createRelationIfAbsentWithClient`. An edge
    `assertRelationCreatableWithClient` refuses for the receiving item with a `ValidationError` stays where it is. An
    edge the receiving item already has is deleted from the giving item and not written again. An edge that is gone
    when its delete runs is not created. It returns `{ moved, refused }`: the number of edges it deleted from the
    giving item, and one `{ relationPropertyId, otherItemId, code, field }` for each edge it left there, where `code`
    is the `code` of the refusing `ValidationError` and `field` its `details.field`, or `null` when it has none.
  - The merge calls it for every user-owned relation property of the Journal database and for no system-owned one.
    It writes those edges as the system writer, the way `transferMailThreadRelationsWithClient` moves the edges of a
    merged mail thread.
  - `events` is written by its owner: the merge calls `syncJournalEventLinks` with the survivor's page as it stands
    after the append. The duplicate's `events` edges are left as they are.
  - `journalDay` is written by the Inbox module: `moveJournalDayEdges` (`inbox/moveJournalDayEdges.ts`) calls the same
    move with the Inbox process context and, when it deleted at least one edge from the duplicate, enqueues the Inbox
    recompute of both entries. It returns the edges that move refused.
- **Trash.** The duplicate is moved to the Trash with `itemDeleteWithClient` as the system writer. Nothing is
  hard-deleted.
- **Result.** The merge returns `{ survivorId, mergedItemId, refusedEdges }`. `refusedEdges` holds the refused edges
  of the user-owned Journal relations and of `journalDay`, in the shape above, and is empty when the survivor took
  every edge. A merge that leaves edges on the duplicate is a success with a stated remainder, not a failure: failing
  instead would make such a period impossible to merge. For each refused edge the merge also writes one `info` line
  of the `journal` logger with the survivor's id, the merged entry's id, the relation property id, the other item's id
  and the refusal's `code`, registered with `runAfterCommit`, so a merge that is rolled back logs nothing
  ([[2026-09-10-side-effects-follow-the-commit]]). The line carries no `field`, name or content.

## Consequences

- A transaction that takes the reservation after the merge took it waits until the merge ends: a
  `getOrCreateJournalItem` that waited returns the survivor, and a second merge of the period that waited finds one
  live entry and returns `null`. A transaction that locks an entry row (a trash of it, `insertPageMarkdown` on it)
  waits from the moment the merge holds that row. Writes that take neither lock are not ordered against the merge.
  This record claims no deadlock freedom beyond the order above: the reservation first, then the two live entries. The
  decision relies on READ COMMITTED, the default of `withTransaction`: the locked read is a new statement and sees what
  committed while the reservation was awaited. No other isolation level was tried.
- The merge reads the duplicate's page once. A document update that reaches the duplicate's page after that read is
  not carried over and stays on the page of the trashed entry.
- A duplicate whose page holds a subpage block, or a link to an item that is not live, cannot be merged while that
  content is there: the merge fails with the insertion's `ValidationError` and changes nothing.
- An edge the survivor cannot take stays on the trashed duplicate. That is an edge to an item in the Trash, and a
  stored `area` of the duplicate when the survivor's `area` is derived from its project. A trashed Inbox item keeps
  its `journalDay` edge to the duplicate, as it does when `journalDayRelinkItemCreateHook` re-links a trashed day.
  Each of them is in `refusedEdges` of the result and in the log. An edge to a trashed item does not reach the
  survivor when that item is restored later, and every refused edge is deleted with the duplicate when the Trash purge
  removes it; the caller of the merge is the one who can tell the user, from `refusedEdges`.
- A period with more than two live entries takes one call for each duplicate.
- A system-owned relation property of the Journal database other than `events` is not moved by the merge. A property
  of that kind added later needs its owner to take part the way the two above do.
- `moveRelationEdgesWithClient` is exported from `chokePoint/relationOps.ts` for callers inside the data package and
  is not part of the package's public barrel. The type of a refused edge, `RefusedRelationEdge`, is, because the
  merge's result carries it.
