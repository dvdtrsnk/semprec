---
status: accepted
date: 2026-10-31
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Delegate backend program decisions to its parent controller

## Context

The owner explicitly authorized the complete sequential backend program and
delegated necessary project decisions, including batch 19, to parent thread
`thr_pz39tcih5r`. The owner also accepted the reported batch 01 result and
instructed merge, worker archival and automatic continuation.

This narrows the human-only security-gate requirement of
[[2026-10-31-sequential-backend-delivery-batches]] for this program. It does not
supersede the default issue store, tenant isolation or deployment decisions.

## Decision

The parent controller supervises the entire main lane, approves exact dispatch
specifications under the owner's delegation, adjudicates findings and scope
contradictions, accepts results, archives completed workers, and starts the next
worker. Workers use Terra 6.1 high; independent reviewers use a fresh Terra 6.1
xhigh context in the same environment. There is still only one source writer and
one working tree. Each batch has a separate branch from the integration branch.

On completion, the worker may perform the authorized local no-ff integration and
guarded issue completion after independent review and all evidence gates. The
parent verifies these results before archival and the next dispatch. Failed or
unfinished work remains on its batch branch. Develop, remote publishing and
production deployment are outside this local program.

The standing authorization covers the currently recorded backend requirements
and necessary, explicitly documented corrective decisions. A proposed spec is
approved at dispatch with its exact hash, not by silently inheriting another
issue's approval. The parent records any necessary specification adjustment,
propagates affected snapshots/hashes and validates the resulting plan before
execution. No worker invents approval or approves its own scope expansion.

Batch 19 remains a security evidence gate, with acceptance assigned to the
parent rather than a mandatory human signature. Independent security review
must be separate from the implementing context. The parent may resolve obsolete
platform or deployment assumptions through a recorded, justified scope decision.
Production assertions still need actual production evidence; a simulation,
missing credential or unperformed check never becomes a production PASS. A
genuine unavailable external prerequisite is reported as such while independent
authorized work continues where possible.

The accepted pilot baseline includes a known macOS MCP environment assertion.
Later workers must distinguish exact reproducible accepted-baseline failures
from new regressions. Baseline exceptions remain explicit in acceptance receipts,
never a false full-verification PASS. New failures, changed security behavior
and unproven failure attribution require parent adjudication before merge.

Archive each finished batch worker only after its result and integration are
verified. Only then create the next batch worker. Keep the parent thread active
as the controller and shared-environment owner. Completion notifications resume
the controller; this decision adds no daemon or replacement Relay scheduler.

## Consequences

Ordinary project decisions and batch progression no longer wait for repeated
owner confirmations. Evidence and review remain mandatory. Human-only language
in the program's security source and aggregate is replaced by delegated parent
authority; the technical checklist is not automatically waived.

The two held client-only batches remain outside the backend-only scope. All
main-lane batches are authorized for autonomous processing, including security
adjudication, without authorizing publication or destructive production tests.
