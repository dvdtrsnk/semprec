---
status: accepted
date: 2026-11-08
area: [backend]
supersedes: []
superseded-by: null
---

# Restore hooks carry the exact deletion epoch, and reserve cross-ordered rows without waiting

## Context

[[2026-11-07-item-delete-and-restore-domain-hooks]] added restore hooks to the choke point's restore
cascade (`restoreItemWithClient` in `chokePoint/itemTrash.ts`). A hook receives `deletedAt`, the
epoch the restore cleared, as the root's `ItemRow.deletedAt`: an ISO string that keeps only whole
milliseconds, while `deleted_at` holds microseconds. The same record decided that epoch membership
is compared by Postgres at full precision, because a row trashed on its own within the same
millisecond would otherwise count as part of the cascade.

Issue #1642 deletes a recording as one unit: `DELETE /api/transcripts/:id` trashes the Transcripts
item and the source Files item its `link` names in one transaction, so both share that
transaction's `now()`. Restoring the transcript from the generic Trash must bring the source back
only when it was trashed together with it. That needs the transcript's epoch at full precision, but
the restore hook runs after the cascade cleared the transcript's `deleted_at`, so the hook can no
longer read it, and the millisecond string cannot tell a source trashed one microsecond apart.

The hook also has to restore the source in the restore's own transaction, through the choke point's
restore, which only `itemTrash.ts` itself could call. And the cascade has locked the transcript before
any hook runs, while the transcription pipeline locks the pair in the opposite order (source Files
item, then transcript).

## Decision

- `ItemRestoreHookContext` gains two required fields:
  - `deletedAtExact`: the root's `deleted_at` as UTC text with all six fraction digits, rendered by
    Postgres as `to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`. It is read
    by the statement that already selects and locks the cascade's epoch rows, from the root row the
    cascade locked, before any row is restored. A hook compares it in SQL
    (`deleted_at = $1::timestamptz`), never through a JS `Date` or `deletedAt`.
  - `queueAffinity`: the queue routing table of the caller that is restoring, for a hook that runs a
    nested choke-point write with it.
    `deletedAt` is unchanged, so existing hooks keep reading the same value.
- `restoreItemWithClient` is exported from `chokePoint/itemTrash.ts`, and not from the package's
  public barrel. A domain restore hook may call it to restore a related item in the same
  transaction, passing the context's `queueAffinity`, `actingUserId` and writer (`writerKind`,
  `agentRunId`). The nested restore is the ordinary cascade: it locks and restores its own epoch
  rows, runs the restore hooks for them and registers its own after-commit invalidations.
- A restore hook that must lock a row which another write path locks before the restored root
  reserves it with `FOR UPDATE NOWAIT` (`itemsStore.lockItemByIdNowait`). Contention raises
  PostgreSQL's `55P03` (`lock_not_available`), which propagates and rolls the whole restore back. It
  is not retried, not waited for and not mapped to a new error category; there is no pre-restore hook.
- The first consumer is `transcription/transcriptRestoreHook.ts` (issue #1642). For a restored
  Transcripts item it reserves the linked source Files item this way, and restores it only when it is
  in the Trash with exactly `deletedAtExact`.

## Consequences

- A hook can tell rows trashed in one transaction from rows trashed separately at another
  microsecond. Equal timestamps are still not a transaction identity: a row trashed on its own at
  exactly the same microsecond is restored as part of the epoch.
- The transcript restore never waits for the source row while holding the transcript, so it adds no
  wait in the opposite order of the pipeline's. This is a statement about this hook's own lock
  acquisition only, not a claim that the lock graph of the backend is free of deadlocks.
- A restore that meets a source row held by another transaction fails as a whole and changes
  nothing: no row, card or job is changed and no invalidation is sent. The `55P03` reaches the
  restore's caller unchanged; this decision maps it to no domain error. A later restore succeeds once
  the other transaction has ended.
- Every caller of `restoreItemWithClient` passes `queueAffinity`, and every restore hook receives the
  exact epoch, so a later consumer needs no change to the cascade to compare epochs.
- Delete hooks are unchanged; they run while the epoch is still stored on the row.
