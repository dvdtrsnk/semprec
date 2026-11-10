---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# The page title mirror reserves the live host

## Context

The `pageTitleMirror` job (#1715) copies the text of `page` blocks onto the titles of the Pages items they name. It read
the host unlocked, then locked and updated children one by one, so a trash of the host could commit between its read and
a child write, against the required no-op for a trashed host. Trashing a host (`itemTrash.ts`) takes a blocking
`FOR UPDATE` on the host row and walks inline databases; it does not lock or trash Pages items by `parentItemId`.

## Decision

The job reserves the host row with the blocking `lockItemById` (the lock a trash takes first) and rechecks that it is
live before it loads the document or writes any child. A host that is missing or trashed at that point makes the job a
completed no-op. The lock order is the host, then the page document, then the Pages items in id order. The paths read for this record take
the host before a Pages item (`createSubpage` and `ensurePage` lock the host first) and none locks a Pages item and then
its host; the trash of a Pages item locks only that item. A trash that starts while the job holds the reservation waits until the
transaction ends, so the trash lands after the mirrored titles.

## Consequences

- Trashing a host does not trash or restore its Pages children; that cascade belongs to later lifecycle work.
- The job holds a row lock on the host for the length of one mirror transaction.
