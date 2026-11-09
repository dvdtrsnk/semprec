---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Page changes replay a bounded, consistent history

## Context

`listPageChanges` (#1680) reconstructs a page from its nearest checkpoint and the retained `doc_history_updates`. A first
version fetched every later row before applying the response limit, read the checkpoint and the rows in separate
READ COMMITTED statements, and applied rows stored by `since` before the rest. `rebaselineDocHistory` deletes rows and
older checkpoints under the document's snapshot lock, and `docHistory.ts` records that timestamp order and update-id
order can differ.

## Decision

- **One snapshot.** The read is one `REPEATABLE READ` transaction (`withTransaction`'s `isolation` option, used by other
  read paths) that takes no lock. The checkpoint, the document row and every history page come from one snapshot, so a
  sweep that commits meanwhile cannot remove rows the checkpoint relies on, and appends and sweeps are not blocked.
- **Update-id order.** Rows are applied strictly in `update_id` order. The stored time only decides what is reported:
  an update stored at or before `since` is applied without a report, any later update with the requested author is
  diffed against the state before it. A causally dependent update is never held back by its timestamp.
- **Fixed budget.** A request replays at most 5000 updates and 16 MiB of serialized input, the checkpoint state included
  and silent updates counted. The size of the checkpoint is read before its state is fetched, and sizes of the next
  rows (up to 200) are read before their bytes, which are fetched in groups of at most 4 MiB (one larger update is
  fetched alone, within the budget). There are no tuning options.
- **Early stop.** The replay ends after the group of updates that fills `limit`, so the rest of the history is not read.
- **Refusal.** A replay that needs more than the budget before the limit is reached is a `ValidationError` on `since`
  with reason `history_window_too_large` (400, flat details); the remedy is a later `since`. A decode error of a stored
  update propagates as it is.
- **Entries.** One update that inserts, updates and deletes blocks yields one entry per change kind present, with the
  same `at` and the ids of that kind. Entries of different updates are never merged.

## Consequences

- The byte budget bounds what is read, not the memory a decoded Yjs state takes, and no claim about CPU, memory or the
  absence of serialization failures is made beyond it.
- `openDocVersionAtWithClient` has the same latent interleaving between its statements; it is not changed here.
