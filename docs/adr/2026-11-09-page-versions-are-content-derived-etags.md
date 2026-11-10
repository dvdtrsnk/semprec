---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# A page's version is a content-derived ETag over its Yjs snapshot

## Context

[[2026-10-28-page-operation-family]] gives clients and agents a Markdown read of a page and, later, a replace that
must refuse a stale writer. Both need a version of the page a client can hold and compare. A document has none: the
`docs` row carries no version column, and `doc_updates` ids cannot serve, because compaction
(`loadDocWithClient` in `docs/docPersistence.ts`) merges the pending rows into the snapshot and deletes them. A token
built on `docs.last_edited_at` changes with every write but not with content, and has timestamp resolution. A Yjs state
vector alone does not change when a write only deletes text, because a deletion adds no new struct.

## Decision

The version of a page is `base64url(sha256(Y.encodeSnapshot(Y.snapshot(doc))))`, computed by `docEtag`
(`docs/pageMarkdown.ts`) over the document as `loadDocWithClient` loads it. A Yjs snapshot is the state vector plus the
delete set, so a write that only deletes text changes the token, while compaction rewrites storage but not the logical
document and leaves it unchanged. The Markdown read sends it as a strong quoted `ETag`.

An item with no page document reads as an empty body with the token of an empty document (`new Y.Doc()`), so the same
token applies once a later write creates the document lazily. A read never creates a document.

The read loads the document the way every other reader does: `loadDocWithClient` takes `FOR UPDATE` row locks on the
document's snapshot and pending update rows for the length of the reading transaction, and compacts when the pending
count has crossed the threshold. That is the existing cost of loading a document; this decision adds no lock.

## Consequences

- The replace operation (#1765) can compare a caller's `If-Match` with `docEtag` of the document it loads under its own
  write lock; this record fixes the token, not that comparison.
- The token identifies content, not an author or a time: two different histories that end in the same logical document
  have the same token. Last-edited time stays a separate field of the page summary.
- Reading is a write-lock holder for the length of its transaction, so a page read waits for an in-flight write of the
  same document and the reverse. Nothing here makes a read and a later write atomic; only a check made under the write's
  own lock can.
- The HTTP route answers an item of another tenant exactly like an unknown id and has no conditional-request branch, so
  the token cannot be used to tell the two apart.

## Alternatives considered

- `docs.last_edited_at`: not content-derived, and equal for two edits within one timestamp tick.
- The greatest `doc_updates.id`: compaction deletes the rows it merges, so the value moves backwards.
- A hash of the state vector alone: a write that only deletes text would keep the token.
- A hash of the serialized Markdown: two different documents with the same Markdown (unknown block types, ids, block
  order the Markdown does not carry) would share a token.
