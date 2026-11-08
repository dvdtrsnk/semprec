---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Bracket a non-transactional external call with a snapshot read and a staleness-checked write

## Context

An action can need to call something that cannot itself run inside a
database transaction — the AI gateway's `AiGatewayClientPort.complete()`
(issue #215) is the first case, but any HTTP call to another service has
the same shape. That call can take long enough for the data it was computed
against to change before its result is ready to persist. Holding one
database transaction open across the external call is not an option: it
would hold locks (and, under `repeatable read`, an old MVCC snapshot) for
the call's entire latency, and a gateway timeout or retry would extend that
further.

Issue #85's `core.agentGuidanceDrift` action (`driftAction.ts`) needed this
shape: it computes a comparison between guidance markdown and a rendered
permission manifest, sends both to the AI gateway, and must not persist a
comparison that was computed against a guidance/manifest state that has
since moved on — silently applying stale AI output would report
contradictions the user has already fixed, or miss ones introduced by a
guidance edit that landed mid-call.

## Decision

Bracket the external call with two separate `repeatable read` transactions
instead of one transaction spanning the call:

1. **Read transaction** — captures one consistent snapshot of everything
   the external call needs, plus enough identity/state to detect staleness
   later (e.g. the source row's owner and `updatedAt`, and any derived
   value — like a rendered manifest — captured as an exact string/value,
   not re-derived after the call).
2. **External call** — outside any transaction. A failure here propagates
   with no state change, since nothing has been written yet.
3. **Write transaction** — reloads the same state and re-derives the same
   values captured in step 1, and requires each to match byte-for-byte /
   field-for-field before writing anything. A mismatch throws a distinct,
   retryable error per stale field (`driftAction.ts`'s `GuidanceChangedError`
   for the source row, `GuidanceContextChangedError` for the derived
   manifest) and writes nothing — the caller decides whether to retry the
   whole three-step sequence with a fresh snapshot.

`repeatable read` on both transactions (rather than the default `read
committed`) is what makes each transaction's own reads internally
consistent with each other — e.g. the read transaction's guidance load and
its manifest render see the same DB snapshot as each other, not a mixture
from two different commits landing between the two reads.

## Consequences

- No transaction is ever held open across an external call's latency.
- Staleness detection is explicit and per-field: a caller reviewing this
  code can see exactly what "the world changed mid-call" means for this
  action, rather than relying on optimistic-locking machinery that doesn't
  know which fields matter.
- Every step-3 mismatch is a full retry from step 1, not a partial merge —
  simpler to reason about, at the cost of re-running the external call on
  contention. Acceptable here because the guidance/manifest state this
  action watches changes rarely relative to how often the heartbeat fires.
- A future consumer of this pattern should reuse the same shape (read
  snapshot → non-transactional call → re-validate → write) rather than
  inventing a new bracketing strategy per action.
