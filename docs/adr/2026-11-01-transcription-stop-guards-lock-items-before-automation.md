---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Lock transcription items before automation when deciding deleted stops

## Context

Gh-1582 stops processing when a Files source or transcript has been deleted or
purged. Queue controls reproduced source purge before a queued attempt and
transcript purge during diarization leaving a failed job. A provider failure
after purge can also reach ordinary failure recording instead of a deleted
stop. Earlier transcript controls with an undefined database ID were invalid
fixtures; the corrected after-create transcript purge is an existing positive.
These observations do not establish a natural failure frequency.

The task currently locks automation before its item writes. Purge deletes an
item before its automation, per
[[2026-11-01-trash-purge-coordinates-roots-and-transactions]]. Adding item locks
only to failure recording would invert the task's other checkpoint guards.
Plain item reads before a later automation write do not protect the decision.
The automation table deliberately has no items foreign key; an ensure after an
unprotected live-item check can create an orphan.

This extends the transaction checks in
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
and preserves the outward error boundary of
[[2026-11-01-transcription-queue-errors-exclude-diagnostic-content]].

## Decision

In transcriptionTask's short transactions that use both items and automation,
use one private order: source Files item FOR UPDATE, transcript item FOR UPDATE,
then its automation FOR UPDATE. Apply it consistently to step-entry and
checkpoint guards, attempt start and failure recording. Acquire exclusive item
locks initially: KEY SHARE would allow ordinary soft-delete, while two SHARE
holders can deadlock when one later upgrades to an item UPDATE after acquiring
automation. Do not merely reverse the order in one failure branch.

Step zero first locks the source before reading/replaying its checkpoint or
creating a transcript and automation. A replayed existing checkpoint on a
trashed source must reach deleted settlement rather than leave the earlier
automation pending. If the source is already purged before an attempt, a narrow
read through the existing transcription idempotency key may recover its earlier
transcript; lock/recheck that row before settlement. Expose only the existing
owner's read-only key lookup if required, with exact tenant/public-surface
coverage; do not scan arbitrary transcript records, create a replacement item
or reserve a new key. If neither target can be recovered, finish without
manufacturing automation.

Before recording ANY normal failure, including a transient one, evaluate both
locked item rows. If either is missing or deleted, return a deleted stop:
mark only existing unlocked automation error/deleted, change no items and write
no notification. Missing/purged transcript automation is not recreated. A
locked automation row remains unchanged; a deleted target still ends this job
successfully. With both targets live, preserve the existing locked outcome and
caller handling. Missing automation on live targets is a genuine invariant
failure, not evidence of deletion or a user lock. Attempt start may use its
existing ensure only while locked item rows establish live targets.

The automation-only stopped-error settlement may retain its existing guard
without taking item locks afterwards. It records an already observed stop and
never ensures a row. Human automation toggles and rerun enqueue likewise add no
item lock after their automation lock. Keep these narrower paths narrow.

Hold no transaction or item lock across gateway, storage or media work. This
cannot prevent deletion immediately after a pre-call transaction commits or
cancel a paid call already in flight. Check again before checkpoint writes and
normal failure recording. Preserve checkpoint reuse, retries, budget and
shutdown behavior, the fixed outward error, and primary failure precedence if
failure recording itself fails. Do not relabel arbitrary SQL or invariant
errors as deletion. Existing repeatable-read snapshots may raise 40001;
that error alone is not a deleted observation.

## Alternatives rejected

- Plain source/transcript reads under the automation lock leave a stale
  decision and invert purge when a later item UPDATE waits.
- Item-first in failure recording alone conflicts with automation-first
  checkpoint transactions. Uniform ordering inside this task is required.
- Recreate automation after purge or label every missing row locked. Neither
  represents the owner's durable state.
- Hold locks through provider work, add a global purge lock, or introduce a
  generic retry framework. These are unnecessary for the scoped guard.

## Consequences

The task's item/automation transactions now use item-first locking. Generic
purge, library automation ownership, schemas and production logging settings
are unchanged. The contract covers the actual canonical Files/Transcripts
source and transcript operations; it does not claim global deadlock freedom or
arbitrary reordered multi-item subtree coordination. Future changes that nest
these canonical system databases must revisit that lock order.

Acceptance requires bounded real queued purge controls, including a throwing
in-flight gateway, source/transcript create-to-start gaps, normal live failures,
existing locked rows, and unrelated error propagation. Forced overlaps use
identified participant PIDs and complete settlement; distinguish deletion-first
from failure-recording-first commits and retain rollback controls. Record raw
pre-fix/invalid-fixture evidence separately. Independent review and clean final
verification remain required; these decisions accept no implementation.
