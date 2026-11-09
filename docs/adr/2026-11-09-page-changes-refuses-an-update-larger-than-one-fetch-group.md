---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Page changes refuse an update larger than one fetch group

## Context

[[2026-11-09-page-changes-replays-a-bounded-consistent-history]] bounds the history replay by a fixed budget and by fetch
groups of at most 4 MiB, and also says that one update larger than a group is fetched alone within the budget. The #1680
decision requires byte pages of at most 4 MiB, so that exception contradicts it: an update of, say, 5 MiB passed the 16 MiB
budget and was read whole.

## Decision

- Every fetch group is at most 4 MiB (4 194 304 bytes), counted from the sizes read before any bytes. An update whose own
  size is above that is never fetched. An update of exactly 4 MiB is allowed.
- The sentence of the replay record about one larger update fetched alone is withdrawn; that record is otherwise unchanged.
- Early stop is kept. Sizes are read first. A valid prefix before an oversized update is fetched and replayed first and may
  already fill `limit`. The replay refuses (400, reason `history_window_too_large` on `since`, the existing safe error) only
  when it actually needs the oversized update, and then before any of its bytes are read.
- The fixed budget of 5000 updates and 16 MiB including the checkpoint, the metadata page and the snapshot are unchanged, and
  there are no tuning options.

## Consequences

- A window that contains an update above 4 MiB cannot be listed from a `since` before that update (unless `limit` is filled
  earlier); the remedy is a later `since`.
- The bound is on serialized bytes fetched. It says nothing about the memory or CPU a decoded Yjs state takes.
