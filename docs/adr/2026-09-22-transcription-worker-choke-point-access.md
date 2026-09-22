---
status: accepted
date: 2026-09-22
area: [backend]
supersedes: [2026-09-17-two-tier-runtime-database-roles]
superseded-by: null
---

# The transcription worker hosts its narrow in-process choke-point writer

## Context

The transcription pipeline must create and checkpoint Transcriptions rows in its own queue
process. Routing that write through `semprec-api` would make a job's durable checkpoint depend
on a second process and split its transaction. The preceding two-tier-role decision assigned
all choke-point access to the API, which cannot support this required in-process transaction.

`semprec-transcribe` is also a third long-lived composition root against the same Graphile
Worker queue that
[[2026-09-19-task-queue-affinity-routing]] split into `api`/`agents`. That ADR's closed
`queueAffinity` union stays the authoritative record of what was decided on 2026-09-19; this
ADR only carves out the additional value this new runtime needs, per that ADR's own documented
path for adding a runtime (a `TASK_AFFINITIES`/`MODULE_TASK_AFFINITIES` two-file change).

## Decision

`semprec-transcribe` receives `semprec_data` credentials and may use only the generic
choke-point package to create Transcriptions items and write its declared computed checkpoint.
It is the sole writer of Transcriptions' `status`, `date`, and `link` system-owned properties.
All other non-API services remain `semprec_side` consumers, and direct SQL writes to
choke-point tables remain prohibited.

Standing up this runtime also extends `queueAffinity` (declared by
[[2026-09-19-task-queue-affinity-routing]]) with a third value, `'transcribe'`, in both
`@semprec/queue`'s `TASK_AFFINITIES` and `@semprec/module-registry`'s `MODULE_TASK_AFFINITIES` —
the transcription module's own tasks (e.g. the checkpointed create step) route to this runtime
the same way core/agent tasks route to theirs.

## Consequences

The shared deployment environment gives the transcription unit access to the data connection
string. Its narrow system-key allowlist makes the process identity enforceable in code while the
catalog's `owner_process = 'transcribe'` makes ownership drift observable.

`resolveTaskAffinitySets` now resolves three disjoint sets instead of two; a module task whose
manifest declares `queueAffinity` other than `'api'`/`'agents'`/`'transcribe'` still fails to
load, as [[2026-09-19-task-queue-affinity-routing]] describes for its original two-value case.
