---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Walks over a subpage's parent chain are bounded at 1000 pages

## Context

[[2026-10-29-subpages-are-items-of-a-hidden-pages-database]] stores a subpage's parent in the text property
`parentItemId` and decides that depth is not limited and that a page is never its own ancestor. Two code paths walk that
chain: creating a subpage must prove the new page does not close a cycle, and the breadcrumb read (`getItemPath`) follows
it to the host. The link is a text value, not a relation, so nothing in the database prevents a stored cycle, and an
unbounded walk over a cycle or an extremely deep chain would hold a transaction and a pooled connection for as long as it
runs. The generic walk in [[2026-09-11-iterative-parent-chain-traversal-in-choke-point]] guards against repeated
databases, which cannot work here: every subpage of a chain lives in the one Pages database.

## Decision

Both walks track the item ids already visited and are bounded at 1000 pages. This is a safety limit of the walk, not a
product limit on how deeply a user may nest pages.

- Creating a subpage walks `parentItemId` from the parent through Pages items to the first item that is not a Pages item
  (the host) or has no usable `parentItemId`, following trashed ancestors too. A repeated id (a stored cycle) or a chain of
  more than 1000 pages is a `ValidationError` on `parent`, and nothing is written. A chain of exactly 1000 is accepted.
- `getItemPath` continues from a Pages item with its `parentItemId`, and from a host that is not a Pages item with the
  host's own database parents. A repeated id ends the walk without an error, a trashed or missing ancestor ends it with
  what was found, and a chain is cut at 1000 elements at its root end. A read never fails because of a stored cycle.

The choke point reads the Pages module key from `seed/pagesModuleKey.ts` (re-exported as `PAGES_MODULE_ID` by
`docs/pagesDatabase.ts`) because it may not import the `docs/` folder.

## Consequences

- Nesting deeper than 1000 pages is not refused for pages that already exist; only creating a page under such a chain is,
  and reading a breadcrumb trail of one shows its leaf-most 1000 elements.
- The limit narrows "depth is not limited" of the subpages record in practice, without reversing it; that record stays as
  written.
- A cycle cannot be built through the API, since no operation reparents a page; the cycle branches exist for corrupted or
  hand-edited data.
