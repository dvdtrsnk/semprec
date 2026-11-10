---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Keep recognition proposals bound to their computed type and target

## Context

Gh-1500 computes an untyped Inbox proposal outside a transaction. Re-filtering its ranked candidates against a changed catalog after that call can promote another candidate or reuse the first proposal for a changed processing method/target. A missing pageContent target is also an allowed uncertain model answer, not an operational error requiring identical queue retries. This extends [[2026-11-01-inbox-fingerprint-inputs-locked-through-proposal-write]] and [[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]. Its v2 fingerprint and source mutation ownership remain unchanged.

## Decision

Retain the original validated ranked selection and bind the computed proposal to the exact selected type identity and processingMethod/target configuration supplied to the computation, plus the concrete target database identity used by the server's reference/operation normalization. A direct-target selection binds its canonical module and actual database. Carry any needed identity in an internal typed server-generated result/snapshot field; it is not a new model-supplied claim, persisted epoch, public API field or request input. Test doubles must honor the same internal contract. Never combine one candidate's proposal with another candidate or a newly resolved destination.

After the call, keep the existing READ COMMITTED source lock/fingerprint/type-edge guards. For the intended type and any clarification choices actually offered (at most four), reserve their existing item rows FOR SHARE NOWAIT in stable identity order using the Inbox guard owner; reserve the concrete target database row(s) FOR SHARE NOWAIT before accepting the result. Use fresh typed reads after reservations to check tenant, live/active state, processing method, configuration and target identity/archive state against the computation binding. Do not lock the full catalog or hold these locks across the model call. Actual pg.DatabaseError 55P03 in these narrow reservations means a nonwriting busy skip, preserving the transaction with the existing Inbox savepoint/skip lifecycle. Do not map arbitrary exceptions or alter generic writers. Missing rows must be distinguished by fresh reads rather than treating a successful zero-row lock as presence.

If the selected type/configuration/target is gone, inactive, archived or changed, write needsClarification for the still-current source, with proposal null, recognizedTypeId null, only freshly valid bounded type choices and a localized uncertainty reason. Do not promote the next candidate using the old proposal, automatically call the model again, write a target item or alter Inbox.type. A missing required pageContent target takes this same controlled clarification path rather than throwing an unknown error before validation. Keep locked-card, fresh fingerprint, no-text and no-content checks and ordinary proposal validation. A source mismatch or busy reserved resource remains a nonwrite; no new enqueue/retry guarantee is claimed. A later unchanged-source call may reuse the clarification under the existing fingerprint gate; catalog edits alone are not promised to re-trigger recognition.

This contract covers the recognition selection and target binding, not a stable snapshot of every writable property catalog, relation or workspace item. Existing proposal validation/confirmation guards remain responsible for those inputs. Normal typed pageContent composition may reuse the missing-target clarification handling without changing dispatch or source fingerprints.

## Consequences

The trade-off favors an honest unresolved card over a plausible proposal for the wrong destination. Reservations can cause short nonwriting skips; no global deadlock-freedom or guaranteed retry/starvation bound is asserted. Retain source-before-nonblocking-type/database-before-nonblocking-card order and existing protected value-link admission. Unknown errors and malformed infrastructure state are not normal uncertainty.

Prove controlled type archive/delete/config-target drift during a held actual computation, no candidate promotion, direct-target identity/archive drift, selected-reservation-first competing update, busy nonwrite, missing page target through the actual computation/tick composition, unchanged positives and foreign controls. Assert no target write and no Inbox.type edge mutation. Keep v2 date/time/attachment inputs with empty untyped source type, stored-v1 compatibility, zero/one-candidate shortages and fixed 0.7 threshold; do not replace them with the stale text-only specification.
