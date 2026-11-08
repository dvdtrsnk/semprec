---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Recording prepare uses a fresh write-side request read

## Context

The visibility sentence in
[[2026-11-05-recording-intake-coordinates-files-and-transcription]] needs an
explicit transaction composition. Acquiring an unchanged Files row after waiting
for intake does not refresh an already established REPEATABLE READ snapshot.
Intake can insert recording_requests and commit without updating that Files row;
the waiting prepare transaction could then miss that accepted request.

This narrowly changes only the prepare write phase of
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]].
Both accepted bodies remain historical records. The item-first ordering from
[[2026-11-01-transcription-stop-guards-lock-items-before-automation]] remains.
No executed reproduction or runtime correctness is claimed by this decision.

## Decision

Only runPrepareStep's final write/recheck transaction uses the existing managed
withTransaction(pool, callback) default READ COMMITTED. Its initial read phase
still uses REPEATABLE READ; normalization, probing and storage/media I/O stay
outside both transactions. All other worker steps and the shared transaction
helper/options remain unchanged. The prepare comment must state this exception.
Do not add a new transaction opener, isolation enum, global/session setting,
retry loop, receipt or timestamp touch on Files to force a snapshot conflict.

At entry to this write phase, verify the effective transaction isolation is READ
COMMITTED before writes, failing closed if a supplied pool changes that default.
Keep requireTranscriptionUnlocked and its Files FOR UPDATE, transcript FOR UPDATE,
then automation FOR UPDATE order. Preserve source/transcript existence and Trash
checks, locked automation semantics, the existing source blob identity comparison
and checkpoint-already-written early return. Keep all date/blob/checkpoint effects
in that same transaction, callbacks after commit, and existing audio/error cleanup.

After acquiring those reservations, read recording_requests through its existing
data owner in a subsequent statement before selecting/writing date. At READ
COMMITTED this statement sees an intake committed before that read, including
one whose Files lock this transaction waited for. Use recorded_at, else media
creation time, else the captured upload time. Intake keeps its Files reservation
until commit; if prepare obtains it first, an overlapping intake follows its
existing NOWAIT recording_busy and whole-transaction rollback behavior. A later
successful intake must not rewrite a committed prepare checkpoint.

The recording timestamp does not change the normalized audio input. Its current
value may therefore be applied during this locked write recheck without rerunning
media work. Other captured source state still needs the existing explicit stale
checks. This exception does not provide a global snapshot, serialized unrelated
schema changes, a guarantee against arbitrary raw SQL writers, or a global
absence of deadlocks. Preserve actual40001,40P01 and other failures; do not relabel
them as a successful recheck or add automatic retry.

## Consequences

The prepare write phase has fresh statement snapshots while its relevant item/
automation state remains reserved. Its guarantee is not that a row lock refreshes
a repeatable-read snapshot. Runtime-role evidence must force intake-first and
prepare-first orderings using the actual intake/task owners, bounded existing
media/storage or SQL observation seams and identified backend PIDs. In the
intake-first case, prove the request inserts while the Files row's stored
properties/computed/version remain untouched, observe prepare waiting for that
owner, then assert the committed date and checkpoint use recorded_at. In the
other order assert recording_busy rolls back request/enqueue/filing effects and
the already committed prepare result is not rewritten by a later duplicate.
Keep source-change/Trash/locked/checkpoint and fallback controls. Do not add a
production test hook, weaken timeouts or run a full pipeline just for this delta.
Implementation, review and final validation still require their real evidence.
