---
status: accepted
date: 2026-10-31
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Execute the backend backlog as sequential technical delivery batches

## Context

The owner explicitly requested backend-only implementation in one working tree,
with review, acceptance-criteria checking and functional verification after a
whole batch, before the next batch starts. Feature epics interleave dependencies
and therefore do not provide a usable sequential execution order.

[[2026-09-24-issue-batches-as-dependency-dags]] remains the default for independent
issues and concurrent Relay work. This decision is a scoped exception for the
backend delivery program listed in `issues/batches/backend/manifest.json`.
[[2026-10-27-repository-markdown-issues-with-a-guarded-cutover]] continues to govern
identity, approval, storage and completion.

## Decision

Represent a technical delivery batch as an ordinary proposed implementation issue
with a new `sp-` identity. It may combine multiple mechanisms. Its body contains
the member specifications, with headings demoted, plus aggregate scope, Touches
and acceptance gates. Keep each body below the existing 60,000-character metadata
validation limit. Do not increase runtime limits for this program.

Keep original implementation records and feature-epic parents. Route each source
record to exactly one batch using a `delivery:sp-...` label and a checked manifest.
Remove source `agent:ready` intent and add `execution:batch-source` and
`agent:blocked`. Labels do not change the original specification hash. Do not
cancel or falsely complete source records to suppress dispatch.

Retain all declared source dependencies, including shared-file ordering. Order
members topologically and assign dependencies to the same or an earlier batch.
Use a predecessor dependency between main-lane batches as an explicit acceptance
barrier, even where that edge is not a capability dependency. Held client work
does not block the main lane. External security sign-off stays a separate human
gate in the lane; grouping work never grants an exemption from it.

Run one source writer in one working tree. Specialists may take over sequentially.
Independent reviewers may read a frozen candidate concurrently without editing
source. Targeted development checks remain useful; independent review, complete
AC acceptance and the full backend pipeline are batch gates. Web/mobile source,
client localization, builds and tests are outside this program.

Every source Task and AC remains binding within its member specification. An
Out-of-scope exclusion for another source does not prohibit that other source's
explicit Task when both are members of this batch. No work outside the combined
Tasks is authorized. Product-client context does not request client delivery.

New batch specifications remain proposed until the owner approves them. Existing
source approvals are not inherited by aggregates. Previously unapproved sources
also require approval before their implementation/completion. Reconcile the
baseline with newer integration work before starting, preserving actual delivery
evidence instead of implementing finished work twice.

After the full gate passes, use existing guarded completion for the approved
batch and each approved source, with individual handovers and the verified
implementation commit. The next batch waits for the predecessor completion and
handover. A feature epic is complete only when all required backend children are
delivered or explicitly deferred by the owner. There is no new completion writer
or approval bypass.

## Consequences

Feature grouping is retained for reporting while execution follows a fixed
technical sequence. A generated manifest and read-only verifier check membership,
source snapshots and dependency placement. New or edited specifications require
an explicit plan update rather than silently changing a batch.

Self-contained specifications limit batch size; several batches may be needed
for related work. A later batch must wait even if some of its tasks are independent.
The production security gate can stop the sequence and needs human action.

This restructuring does not change Relay's runner or add multi-issue completion
support to it. Use the program's manual single-tree protocol; do not assume a
legacy one-issue worker will close all source records. No workflow is dispatched,
deployment performed, or approval issued by creating the program.
