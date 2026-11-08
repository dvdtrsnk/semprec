---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Bound speech phase admission without abandoning database settlement

## Context

[[2026-11-06-message-speech-cache-brackets-gateway-io]] specifies one absolute speech deadline no longer than the existing five-minute gateway client bound. The route uses withTransaction on a separate data connection; that helper has no AbortSignal for checkout, statements or COMMIT. A signal checked around awaits does not cancel an already issued database operation. Therefore the earlier deadline sentence cannot honestly promise a five-minute wall-clock return or resource-settlement bound.

This decision narrowly defines that sentence's admission/cancellation meaning. [[2026-11-06-message-speech-voices-and-session-loss-bounds]] continues to govern guard loss and uncertain commit. Neither accepted ADR body is edited and no global transaction behavior is replaced.

## Decision

Use one monotonic absolute deadline for speech request admission, contention waits and new fill phases, at most five minutes from entry. Do not reset a full budget for each phase. Check it before each phase and after awaited operations; pass cancellation through the existing gateway stream and destroy/cancel owned byte streams on expiry or disconnect. After expiry, do not start a new external call, storage write or cache transaction. A late return from an already issued operation is not timely success and must not start another fill phase.

Cleanup and ownership-reconciliation reads may begin after expiry to settle this attempt; they are not another fill phase. A PostgreSQL query, checkout, managed transaction, COMMIT or cleanup already started must still be observed to settlement. Existing connection and statement limits remain active. Await the actual owned operation before deciding rollback, cache/blob ownership or guard release. No Promise.race may return early while silently abandoning that work. Do not change db/pool.ts, issue manual transactions, add a generic cancellation/fencing protocol, alter existing database timeouts, or claim AbortSignal cancels an issued COMMIT.

If expiry is observed inside the final transaction callback before it returns, reject the callback so withTransaction rolls back. If the callback has returned or COMMIT is already in flight, settlement may still commit. A response may report timeout/failure after persistence; do not synthesize again automatically or delete audio that may be committed. Re-read the cache/blob ownership when possible; when the outcome cannot be established, retain the bytes and report uncertainty under the preceding decision. Preserve primary, guard and cleanup failures rather than masking them.

The five-minute bound is an admission/external-work cancellation deadline, followed by observed database/cleanup settlement. It is not a hard end-to-end settlement guarantee. Configured server statement limits do not by themselves prove receipt of a response during a broken database transport, so even an aggregate numerical settlement bound is not claimed. Unsettled work is never reported as released, rolled back or successfully cleaned merely because a timer fired. Any future hard return-time guarantee needs an explicit data-client cancellation/ownership design and its own evidence; it is not silently implemented in this route.

## Consequences and evidence

No new source owner is needed: use the already granted speech handler/store/test paths. Prove expiry prevents a subsequent phase, a delayed in-flight database callback is awaited rather than abandoned, and late commit/failure is distinguished from timely success without deleting possibly committed bytes. Controlled clocks or strictly delegating delayed/faulted SQL observation may establish those finite schedules; they do not attest a real network partition, server cancellation or universal five-minute settlement. Existing gateway cancellation, lock-client cleanup and source/cache/blob arbitration controls remain required.
