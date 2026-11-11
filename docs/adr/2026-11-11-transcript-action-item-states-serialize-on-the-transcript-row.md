---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# Transcript action item states live in a side table and serialize on the transcript's row lock

## Context

A transcript's meeting notes are stored once in `computed.meetingNotes` (gh-1695). Their action
items have no identity beyond their position in the stored `actionItems` array, and only cache
writers write `computed`: a user has no write path into it. Gh-1754 lets the user follow an action
item, and gh-1767 will turn one into a task. Both need a state per transcript and action item that
is the same on every device.

`items` is partitioned with the composite primary key `(database_id, id)`, so a side table cannot
declare a foreign key to it. The permanent purge removes such rows itself, in
`deleteItemDependents`. [[2026-11-07-item-delete-and-restore-domain-hooks]] limits the listed-domain
modules `chokePoint/itemTrash.ts` may import to the seven its purge called at that time, and leaves
hooks on the permanent purge undecided.

The open state is the absence of a row. A guard such as "an item whose state is `added` is not
followed" therefore decides from a row that may not exist, so there is no state row to lock for it.

## Decision

The state is a row of `transcript_action_item_states`, keyed
`(tenant_id, transcript_item_id, action_item_id)` with `action_item_id` the item's position in the
stored array, and holds `added`, `noted` or `dismissed`. Rows are stored and cleared through
`transcription/transcriptActionItemStates.ts`, not through the choke point's item writes: a state
row is not an item property and writing one changes no item. The only other statement on the table
is the purge's delete below. The user's write is the custom route
`PUT /api/transcripts/:id/action-items/:actionItemId/state`, declared under
[[2026-09-11-module-manifest-custom-routes]] with `transactional-semantics`.

The row lock of the transcript's item (`SELECT ... FOR UPDATE`, `itemsStore.lockItemById`) is the
lock for every state of that transcript:

- `setActionItemState` and `clearActionItemState` take it before their statement and refuse a
  transcript whose item row does not exist.
- A caller that decides from the stored notes or the stored state takes it before those reads, in
  the same transaction, and writes through the store afterwards. The route does so. Taking the lock
  a second time in one transaction does not wait.
- The route's transaction runs at READ COMMITTED.

The permanent purge deletes a purged transcript's rows with one statement in
`deleteItemDependents`, after it removed the item row in the same transaction. The statement is
inline and `itemTrash.ts` gains no import. A transcript in the Trash keeps its rows, and the route
answers 404 for it like for an unknown id.

`task_item_id` and `owner_person_id` are plain ids without a foreign key. The route stores in
`owner_person_id` the live person the transcript's `speakers` edges map the item's owner speaker to
at that write, or NULL.

## Alternatives rejected

- Keeping the state inside `computed.meetingNotes`. It needs a user write path into `computed` and
  rewrites notes that are stored once.
- Locking the state row, or relying on the primary key. An open item has no row, so two writers that
  both read "no row" would both proceed.
- SERIALIZABLE transactions. They turn the race into serialization failures that every caller has to
  retry.
- An advisory lock per transcript. It would not coordinate with the purge, which removes the item
  row, or with the writers that already lock that row.
- A store function imported into `itemTrash.ts`, or a purge hook. The boundary rule
  `item-trash-domain-imports-are-purge-only` refuses the import, and no purge hook registry is
  decided.

## Consequences

- A later writer of this table, the task creation of gh-1767 included, takes the transcript's row
  lock before it reads the state and writes through the same store. A path that locks further items
  in that transaction decides their order itself; this decision orders nothing beyond the one row.
- A state write waits for every transaction that holds the transcript's row lock: a `speakers` edge
  write, a write of the pipeline to the transcript, its trash or restore. A writer that waited for a
  permanent purge finds no item row and is refused; the rows of a writer that committed first are
  purged with the transcript.
- A purge of the task or the person a row names leaves that id in the row. A reader resolves the id
  and treats an item it does not find as absent.
- A state write changes no item and announces nothing: no item version changes and no invalidation
  is sent. No route returns the states at this decision's date.
- The table is tenant-classified with row-level security, so the tenant export includes it and the
  tenant erase removes it through their catalog-driven table sets.
