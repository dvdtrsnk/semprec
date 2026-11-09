---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Page HTTP routes and subpage paths follow the delivery contracts

## Context

[[2026-10-28-page-operation-family]] lists the HTTP path of every page operation and puts all of them on `core.page.*`
capabilities. [[2026-10-29-subpages-are-items-of-a-hidden-pages-database]] says the breadcrumbs of a subpage are not
read through `getItemPath`. The delivered contracts of #1676, #1679, #1680 and #2014 differ from those sentences in
four places, and the older records stay as they are.

## Decision

- **Insert route.** Markdown is inserted with `POST /api/items/:id/page/insert`, the path the #1679 Task names, not
  `/page/blocks`. The operation is still `page.insert` with the capability `core.page.write`.
- **Breadcrumbs.** A subpage's trail is built by `getItemPath` (`chokePoint/itemReads.ts`): the walk continues from a
  Pages item through its `parentItemId`, then along the host's own path. It is bounded at 1000 elements and ends at an
  item id it has already walked. A live Pages item whose parent is missing or trashed keeps its one-element trail, and
  no parent document is read. #2014 states this as its Task; the walk of the subpages record is superseded for this
  case only.
- **`page.changes`.** The history list is a catalog operation (`core.page.read`, a read, no approval), as the family
  record says. Its REST binding is `GET /api/items/:id/page/changes` with `since`, `by` and `limit`, and its output is
  the array `[{ at, blockIds, kind }]`. `page.get` with `format: "markdown"` is the catalog read of the page body;
  `GET /api/items/:id/page.md` is its HTTP binding, not a second operation.
- **`page.createSubpage` capability.** It is a non-destructive write on `core.item.write`, as the #1676 Task says, an
  exception to the family table. `page.insert` stays on `core.page.write`, and no automatic project-agent grant is
  added ([[2026-11-06-page-capability-registration-does-not-grant-project-agents]]). An agent that holds
  `core.item.write` can therefore create a subpage, and it cannot insert Markdown unless it was granted
  `core.page.write`.
- **Insert placement.** Every element of the flat parser output needs one supplied block id, indented list items
  included. `afterBlockId` anchors the new blocks at the nesting level of the target: each block keeps its parsed
  indentation relative to the target, and a result above the existing maximum indentation is refused (400, nothing
  written). `start` and `end` keep the parsed indentation. Markdown with no block still checks the placement.

## Consequences

- The older records are not edited. Code and tests follow this record where it differs from them.
- A client or an agent reads the route table of the code, not the family table, for `insert` and `changes`.
