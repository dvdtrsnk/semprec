---
status: accepted
date: 2026-09-22
area: [backend]
supersedes: []
superseded-by: null
---

# `queueAffinity` gains a third value for the transcription runtime

## Context

[[2026-09-19-task-queue-affinity-routing]] declared `queueAffinity: 'api' | 'agents'` as a
closed two-value union, covering the two composition roots that existed against the shared
Graphile Worker queue at the time. [[2026-09-22-transcription-worker-choke-point-access]] stands
up `semprec-transcribe` as a third long-lived composition root against the same queue, with its
own narrow in-process choke-point writer.

The 2026-09-19 ADR's own Consequences section anticipated this: adding a third runtime is
documented there as a two-file change (`TASK_AFFINITIES` in `@semprec/queue`,
`MODULE_TASK_AFFINITIES` in `@semprec/module-registry`) plus updating
`resolveTaskAffinitySets` callers. This ADR is that change, recorded separately because the
2026-09-19 ADR's body is an accepted historical record and does not get edited to carry it.

## Decision

`queueAffinity` gains a third value, `'transcribe'`, in both `@semprec/queue`'s
`TASK_AFFINITIES` and `@semprec/module-registry`'s `MODULE_TASK_AFFINITIES`. The transcription
module's own tasks (e.g. the checkpointed create step) declare `queueAffinity: 'transcribe'` and
route to the `semprec-transcribe` runtime the same way core and agent tasks route to theirs.

This carves out an additional value within the mechanism [[2026-09-19-task-queue-affinity-routing]]
defined; it does not change or replace that ADR's core/agent split, its resolution mechanism, or
its per-key ownership model, so it does not supersede it.

## Consequences

`resolveTaskAffinitySets` now resolves three disjoint sets instead of two; a module task whose
manifest declares `queueAffinity` other than `'api'`/`'agents'`/`'transcribe'` still fails to
load, as [[2026-09-19-task-queue-affinity-routing]] describes for its original two-value case.
