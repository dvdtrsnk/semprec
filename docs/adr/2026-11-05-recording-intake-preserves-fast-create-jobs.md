---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Recording intake preserves observed fast-create jobs

## Context

[[2026-11-05-recording-intake-coordinates-files-and-transcription]] preserves an
observed queued or running transcription job under the intake owner's existing
Files reservation. Gh1624 adds a separately keyed transcriptionCreate worker.
Unconditional replacement of its job during duplicate intake can reset queued
attempts or create a running-job successor despite the same immutable request.
This extends only that intake rule to the new fast key; the earlier ADR remains.

## Decision

In recordingIntake, under the existing Files reservation and absent create
checkpoint, inspect each task's existing key independently through the current
public keyed-job lookup owner. Enqueue transcriptionCreate only when its own
key has no observed job; apply the same existing rule separately to transcriptionJob.
Preserve the observed job identity, payload, scheduling and attempts for queued
and running jobs. Finding one task does not prevent enqueueing the other when
that other key is absent. Keep both decisions in the intake transaction.

Add the fast-key lookup beside the existing transcriptionJob owner and use the
same supported public jobs view. Do not add a Graphile-private write, unsafe
queue dedupe mode, lock, receipt, new key scheme or schema. This is preservation
of an observed job under the existing producer reservation, not a claim that
worker completion and enqueue are globally atomic. A completion after the
observation may leave safety-net work for a later producer; the idempotent
create owner remains responsible for one transcript.

Leave the existing shared enqueue helpers' ordinary replace behavior intact
for callers that deliberately request it. The existing Files-trigger rule that
skips an accepted recording request is unchanged, as are explicit requeue/rerun
and non-recording producer semantics. No third worker or new process owner.

## Consequences

Use the existing recordingIntake and recordingsHandler fixtures to exercise
queued and held-running fast jobs with duplicate intake. Assert stable job
identity and attempts, no replacement/successor from that duplicate, separately
missing-key admission, rollback/no effects and same/foreign tenant controls.
Use the real intake and lookup owner, not a stubbed admission result. Historical
unconditional-replacement tests remain evidence of the earlier candidate only.
