---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# The snapshot-hash and proposal-id claims are narrowed

## Context

[[2026-11-09-page-versions-are-content-derived-etags]] and
[[2026-11-09-confirmed-page-content-derives-block-ids-from-its-proposal]] describe algorithms that the code and the
specifications keep unchanged, with two explanatory sentences that are wrong.

## Decision

- **ETag.** The token is `base64url(sha256(Y.encodeSnapshot(Y.snapshot(doc))))`. A snapshot holds the state vector and
  the delete set, so it reflects the CRDT history of the document: two documents with the same visible content that
  were reached through different histories can have different tokens. The token identifies a document state, not visible
  content, and the earlier sentence that equal content gives an equal token is withdrawn.
- **Block ids.** Block number `i` of a confirmed card gets the version 5 UUID of the proposal id and `block:<i>`.
  The ids depend on the proposal id and the position only. Revising a card's Markdown keeps its proposal id, so the
  ids of the revised card are the same positions' ids, and the earlier sentence that a changed Markdown changes the ids
  is withdrawn. A repeated write of one card still collides on those ids instead of adding a second copy.
- **Section end.** `afterHeading` is resolved to the end of the section once, inside the document mutation of the
  confirm, and the blocks are then inserted after that block. No `{ endOfSection }` placement is part of the insert
  contract.
- **Captions.** The Markdown serializer's `resolvePageTitle` receives the block as a second argument, so two page blocks
  that name one page id keep their own captions.

## Consequences

- The two earlier records stay as written; code, tests and readers follow this record for these four statements.
