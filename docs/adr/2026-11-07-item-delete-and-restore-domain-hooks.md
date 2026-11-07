---
status: accepted
date: 2026-11-07
area: [backend]
supersedes: []
superseded-by: null
---

# A domain reacts to or vetoes an item trash or restore through delete and restore hook registries

## Context

[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] gave the choke point
per-process hook registries and exempted `chokePoint/itemTrash.ts` from the
`chokepoint-knows-no-domain` boundary rule: its cascade delete, restore and purge imported domain
stores directly and, as that record put it, the `itemDeleteWithClient` path was "deliberately left
without a hook". [[2026-10-09-item-create-domain-hooks]] then added a registry for the insert.

Domains now need the trash and the restore themselves: calendar deletion with its Events, journal
day restore, recording and transcription cleanup, search reindexing, last-contact derivation,
invitations, mailbox removal, recurring-series trash and value-link detaching all have to run inside
the transaction that trashes or restores an item and be able to veto it. Importing each of them into
`itemTrash.ts` would grow the exception into exactly the coupling the boundary rule exists to prevent.

This decision narrows the `itemTrash.ts` exception of
[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]: the trash and restore
cascades run hooks, and the file stays exempt from `chokepoint-knows-no-domain` only for the
listed-domain imports its permanent purge still needs. That record is accepted and is not edited.

The restore cascade restores only the rows trashed together with its root: every row one trash
cascade soft-deletes shares the transaction's `now()` as `deleted_at` (its "cascade epoch"). The
restore compared each row's `ItemRow.deletedAt` with the root's. That string keeps only whole
milliseconds, while `deleted_at` holds microseconds, so a row trashed on its own in another
transaction within the same millisecond compared equal and was restored with the cascade. A restore
hook that is meant to run only for the rows of the epoch inherits whatever rule decides membership.

## Decision

`chokePoint/hooks.ts` gains two registries with the `Set` semantics of the others (registering a
function twice is a no-op; hooks run sequentially in registration order; the first rejection
propagates; `clearHooksForTests` clears them): `registerItemDeleteHook` / `runItemDeleteHooks` and
`registerItemRestoreHook` / `runItemRestoreHooks`. A hook receives
`{ client, database, item, rootItemId, deletedAt, writerKind, agentRunId?, actingUserId? }`:
`database` is the `DatabaseRow` of the row's database, `item` the row after the change,
`rootItemId` the item the caller trashed or restored, and `writerKind`/`agentRunId` come from the
`writer` option of the trash entry points (`system` when absent).

- `itemDeleteWithClient` runs the delete hooks for every row its `softDeleteItem` calls actually
  trashed, root first in the cascade's subtree order, each right after that row's soft delete and
  before its `onItemEvent` heartbeat trigger. A row already in the trash runs none. `deletedAt` is
  that row's `deletedAt`, which every row of the cascade shares.
- `restoreItemWithClient` runs the restore hooks for every row it actually restored, each right after
  that row's restore, with `deletedAt` set to the epoch the restore cleared (the root's `deletedAt`).
- A repeat delete of a trashed root and a restore of a live root stay no-ops and run no hook.
- Both run inside the cascade's transaction, before it commits, so a rejection rolls the whole
  cascade back: every row keeps its previous `deleted_at`, and the after-commit invalidations of the
  cascade are discarded with it.
- Epoch membership is decided by Postgres: the restore selects the subtree rows whose `deleted_at`
  equals the root's at the column's full precision and locks them `FOR UPDATE` in subtree
  (root-first) order before restoring any of them. That is the order both cascades write rows in, so
  a concurrent trash or restore of a row in the subtree waits for the restore instead of changing the
  epoch the row was matched on.
- The permanent purge (`purgeExpiredTrashSubtree`) runs no hook.
- `chokepoint-knows-no-domain` keeps exempting `itemTrash.ts`, now only for the seven listed-domain
  modules its purge (`deleteItemDependents`) calls: `blobs/blobsStore`, `docs/docsStore`,
  `inbox/inboxAttachmentsStore`, `inbox/itemOriginsStore`, `library/itemAutomationStore`,
  `transcription/recordingIntake` and `transcription/transcriptionComputedKeys`. A second rule,
  `item-trash-domain-imports-are-purge-only`, refuses any other listed-domain import in
  `itemTrash.ts`.

## Consequences

- A domain that must act on, or refuse, a trash or restore registers a delete or restore hook in
  `domainWriteHooks.ts` next to its own code; `itemTrash.ts` gains no domain import.
- A hook's rejection fails the whole `DELETE /api/items/:id` or `POST /api/items/:id/restore`, and
  the agent and MCP trash paths that reach the same cascades.
- A restore now holds row locks on every row of its epoch from before the first restore until it
  commits. The restore is atomic: the epoch rows are restored together or not at all.
- Hooks on the permanent purge and on database or property archive and delete remain undecided; a
  consumer that needs one needs its own decision.
- This decision registers no consumer hook; each consumer registers its own.
