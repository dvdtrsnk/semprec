---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Coalesce document invalidation lookups at delivery

## Context

Gh-1625 derives thin tenant document invalidations from doc_update. Stored last_edited_at comes from the update transaction's timestamp: a transaction that began earlier can commit later with a smaller timestamp. Timestamp maximum therefore does not identify the final persisted write. Independent asynchronous lookups can also complete out of notification order.

This specializes [[2026-10-16-tenant-scoped-realtime-fan-out]] for the new leading/trailing document throttle. It changes neither document timestamp persistence nor the existing binary document fan-out, and introduces no durable notification replay or revision field.

## Decision

The throttle owns signal coalescing and its asynchronous lookup lifecycle. Key state by the unambiguous tenant/docId pair. Record each accepted notification signal before awaiting asynchronous binary fan-out or row lookup, so those operations do not redefine the arrival window. Preserve the existing binary fan-out and error path independently.

The first signal in a quiet period schedules the one-second window and starts the owned leading lookup. Send the resolved current frame promptly, if the document/item still exists and the server is open. Subsequent signals mark one dirty state; they do not start one lookup per event or enqueue an unbounded promise chain.

At the trailing boundary, if dirty, wait for the owned leading lookup to settle and perform one fresh tenant-scoped read of the current persisted document/item state, then send its valid frame. Reserve at most one lookup in flight per key. Signals received while a trailing lookup is running become the bounded pending state of the next window, not parallel reads. When a complete burst arrived before the first window boundary, its final read starts after that burst and sends the final persisted lastEditedAt. No intermediate per-event lookup result creates an extra emission. Continuous activity can produce subsequent one-second windows; the at-most-two guarantee is for a burst arriving in one window, not all future edits.

Newest means the fresh persisted state for that delivery. Never select max timestamp, force timestamp monotonicity, reuse a stale lookup completion or interpret doc_updates.id as commit order. A smaller lastEditedAt is valid and must be deliverable. Read under the event tenant, preserve item/database/doc identity and missing-document skip, and send only to that tenant's open sockets, including unsubscribed ones.

Keep one timer/dirty state and the owned lookup per active document; remove quiet entries only after timer/lookup settlement. No per-event FIFO, permanent touched-document cache or public test hook is added. Failed best-effort lookups are observed and reported through the existing safe error owner, with fixed stage/category diagnostics rather than user content, SQL or raw unknown errors. They do not report a delivered frame or create an internal retry loop.

Close first prevents new signals/reads/sends and clears timers, then joins the actual owned lookups, using their existing bounded pool/query lifecycle. Do not report settlement from an elapsed outer timeout, drop a still-running promise or start a new read after close. A held lookup keeps close pending until its actual completion; underlying failure remains observed. Preserve existing socket shutdown ordering and no post-close delivery. This is not a claim of immediate shutdown or successful cancellation of an unobserved query.

## Consequences

Gh-1625 Task3 is reconciled from per-event read-before-enqueue to enqueueing identifiers and resolving only for the leading/trailing deliveries. The supplied resolver stays in syncServer and uses existing data readers; no data timestamp/schema, new publisher, client feature, pool timeout or unrelated coalescer changes are authorized.

Prove pure bounded-window state including a held leading read, dirty burst, maximum one lookup, decreasing timestamps, failure/missing state and close with a held lookup. Compose actual document writes, PostgreSQL signals and owner/foreign sockets; distinguish a burst actually arriving within one second from slower writes spanning windows. Check last frame against the final stored row. Add an actual earlier-start/later-commit control which lowers lastEditedAt, and show that the final frame carries that value. Existing single-update and binary subscription/cap controls remain. Unit fake time alone is not the real socket proof.
