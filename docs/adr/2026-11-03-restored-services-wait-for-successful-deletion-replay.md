---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Keep restored services offline until deletion replay succeeds

## Context

The historical gh-1078 runbook starts services before instructing the operator
to handle replay refusals. A restored ledger-listed tenant may remain active
when the existing owner refuses `lastAdmin` or `unexpectedStatus`. The CLI
already fails; the activation order is the defect. Corrective issue
`sp-a0f046dd-8781-4141-bc04-5dad0b725faf` owns this correction. Historical issue
bodies and handovers remain unchanged.

## Decision

Require application-facing services, workers, and relevant timers offline
throughout restoration, key import, ledger validation, replay, and refusal
resolution. The database is accessible only to the offline operator. This is an
operational prerequisite, not a new runtime feature flag or a claim that the
single-tenant index still exists.

The runbook contains one uniquely marked, directly executable Bash sequence.
It sets `-euo pipefail`, checks required nonsecret configuration presence,
fetches the newest explicitly path-selected replay ledger, validates it against
the restored main, runs the actual native deletion replay CLI, and only after
all succeed starts the four named application units. It is not a function
invoked in an error-suppressing conditional or a command followed by `|| true`.
No activation command precedes either validator or replay success.

Every nonzero outcome remains offline: malformed or unavailable ledger,
validator failure, absent native module, unexpected error, `lastAdmin`, and
`unexpectedStatus`. Resolve the exact refusal manually while offline and rerun;
do not bypass the existing guards or automatically delete the final admin.
Partial successful replay remains governed by the existing idempotent owner.
A later service-start failure does not imply that all services started; it also
does not change the prerequisite that replay succeeded before any start.

Test the actual identified documentation block with controlled activation and
tool commands, plus forwarding real replay/validator refusal and success
evidence against owned fixtures. A duplicate implementation inside a mock is
not proof of the documented sequence. Local controls never constitute a
production restore or permission to start real services.

## Consequences

The new order corrects the earlier issue's unsafe sequence without weakening
replay's failure contract. It composes with
[[2026-11-03-later-replay-ledger-covers-snapshot-tombstones]] and
[[2026-11-03-offline-compatible-tenant-key-restore]]. The gate remains a trusted
offline-operator procedure; it does not prevent a privileged operator from
ignoring instructions or replacing a protected artifact between commands.
