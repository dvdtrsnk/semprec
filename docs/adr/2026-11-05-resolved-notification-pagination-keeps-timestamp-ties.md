---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Keep timestamp ties when paging resolved notification reads

## Context

Gh-1559 introduces an authenticated, tenant-scoped resolved-notification read.
Its proposed timestamp-only continuation skips rows when more than 500 rows
share a resolution time. PostgreSQL also stores finer timestamp precision than
JavaScript Date, so a millisecond-only round trip cannot represent the boundary.
The endpoint is new; no client implementation is part of this backend batch.
Existing notification writers and other notification response shapes stay intact.

This extends read reconciliation under
[[2026-10-03-tenant-isolation-through-row-level-security]]. It does not change
resolution ownership, impose a commit-order log or create a persistent cursor.

## Decision

Keep required `since` and the cap of 500. Add optional `afterId` to
`GET /api/notifications/resolved`. A first request without afterId selects
`resolved_at > since`; a continuation supplies both values returned by this
endpoint and selects `(resolved_at, id) > (since, afterId)`. Order by
`resolved_at ASC, id ASC`, within the authenticated user's tenant and user id.
Bind values as SQL parameters; no cursor lookup may disclose another user's row.

Return `{ resolved: [{ id, resolvedAt }], nextCursor }`. For a nonempty page,
nextCursor is `{ since: last.resolvedAt, afterId: last.id }`; for an empty page
it is null. A caller may stop draining when fewer than 500 rows are returned,
retaining the last nonempty cursor. A full last page can require one empty
request. Do not infer more rows from the existence of a cursor.

Only this endpoint's resolvedAt and cursor since use canonical UTC timestamps
with exactly six fractional digits, `YYYY-MM-DDTHH:mm:ss.ffffffZ`, formatted
from the stored timestamp in SQL without passing through Date. Required since
input accepts validated ISO calendar timestamps with timezone and up to six
fractional digits, with a bounded length. Preserve the full validated value
when binding it as timestamptz; never silently truncate its fractional digits.
A missing or malformed since or malformed afterId is 400. Authentication and
NO_STORE apply to both success and refusal as in the existing HTTP contract.
Other notification DTO timestamps are unchanged.

This is deterministic keyset traversal of the currently visible qualifying
rows, including arbitrarily many equal timestamps across bounded pages. It is
not a cross-request repeatable-read snapshot or a commit-order change stream.
A concurrent transaction can commit an older resolution time behind a cursor;
this API does not solve that separate historical-writer/commit-order problem.
Do not change now(), existing resolution writers, schema, locks or production
client behavior under this decision, or promise lossless concurrent history.
No inclusive timestamp/dedup protocol, offset paging, opaque signed token,
unbounded response or shared server cursor is introduced.

## Consequences

The new response has a cursor and a secondary key rather than the former
instruction to advance the timestamp alone. Retain ids and resolution times;
no notification content or foreign metadata is added. The store's optional
secondary boundary is local to this read and uses the existing indexed owner.
The issue's model tier becomes medium for the explicit precision/continuation
contract and its boundary tests; the worker must not reclassify it itself.

Runtime store and authenticated HTTP tests must drain more than 500 rows at
one timestamp across pages with no duplicate or missing id, prove stable id
order and sub-millisecond boundaries, and cover empty/before/equal/after,
invalid input, cap, NO_STORE, unauthenticated, own positive and foreign/random
no-effect behavior under a non-bypass runtime role. Full test fixtures and
SQL must preserve tenant scope and supported notification ownership. This is
server-side evidence, not a claim that an app client implements continuation.
