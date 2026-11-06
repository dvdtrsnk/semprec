---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Observe blob-open stream cleanup before fallback or failure

## Context

[[2026-10-18-tenant-export-cross-root-blob-lookup]] selects primary-root then ENOENT-only alternate lookup. [[2026-11-06-semp-reference-reads-stay-in-data-owners]] composes these roots for gh1740/1752 outside metadata transactions. The batch cancellation disposition requires ownership and observed stream cleanup. Calling destroy and returning, with only a test waiting for close afterward, does not establish closure before the helper returns or opens the alternate root.

The production LocalFsBlobStorageWriter returns ordinary Node fs read streams. The BlobStorageWriter read transport also permits Node Readable implementations: close can be asynchronous, emitClose may be false, a stream may already be closed, or a custom destroy implementation may never settle. An unconditional wait for a future close event cannot cover those cases. Node documents destroy as initiating destruction and notes that emitClose:false suppresses the event; closed is a separate public observation. See [Node streams](https://nodejs.org/api/stream.html#readabledestroyerror) and [readable.closed](https://nodejs.org/api/stream.html#readableclosed). Do not use private stream state or the undocumented second destroy callback.

## Decision

Repair only openBlobFromRoots.ts and its existing mail/**tests**/blobStorage.unit.test.ts for the two scoped members. No storage interface, root selection, read/write owner, public export, database transaction, schema or provider protocol changes. The returned successful stream still transfers ownership to its caller; this decision concerns streams the helper still owns before that transfer.

Register close and error observation before initiating destroy. Observe actual close, or public closed state, before an ordinary cleanup result can settle. Do not resolve a close wait merely on error or on destroy returning. Treat an error before first readable or a premature close as an opening failure; an already closed stream must not await a future readable/close event. Keep the exact original error when one exists. A closed stream with no readable result and no existing error uses a fixed premature-close failure, not synthetic ENOENT. Observe/remove the helper's readable/abort/close/error listeners according to actual ownership; no late successful stream handoff.

On initial-read error, abort, or cancellation between opening and ownership transfer, initiate cleanup and observe it inside the helper. On primary ENOENT, only after successful cleanup may the helper recheck cancellation and open the alternate. Any distinct cleanup failure, deadline failure or cancellation forbids fallback. On abort, never open the alternate even when the original error was ENOENT. Pre-abort before acquisition opens neither stream. Actual successful range behavior and uncancelled both-missing null behavior remain unchanged.

Use one internal five-second cleanup allowance per openBlobFromRoots invocation, starting at its first cleanup attempt; do not restart it for a second root or more events. This is a cleanup waiting policy, not a new initial-read timeout, a caller-signal extension or an end-to-end hard wall bound. A recursive timer can inspect public closed at most every 10 ms, capped by the remaining absolute allowance, so emitClose:false requires no private-state inspection or indefinite event wait. Close events normally settle earlier. At every timer/continuation check absolute expiry before initiating fallback or reporting a newly observed closure as within allowance. A closure recorded before expiry remains a recorded settlement if its continuation runs later. Event-loop scheduling can delay return; never advertise a strict wall-clock completion guarantee.

If no terminal closure was observed within allowance, return failure saying cleanup closure was not observed within its deadline, never success/null/fallback. Preserve the original opening/abort error as the primary value and include the fixed cleanup-deadline error and any already observed distinct cleanup error in order. Current closed state may subsequently become true; do not claim the resource remains live forever or that an elapsed timer proves closure. Do not suppress a deadline failure merely because a delayed callback later finds the stream closed.

The actual stream operation remains observed after a deadline outcome. Retain one nonthrowing bounded late error/close observer on that stream, without a global registry, repeated destroy, retry, continuing poll/timer or unresolved rejecting promise. Remove late observers on actual close when it occurs. A stream configured not to emit close may retain that fixed observer until it becomes unreachable; no growing error history is retained. Late errors must not become uncaught or unhandled, create a late success/fallback, or erase the original outcome. Keep only bounded safe diagnostic category/count metadata and the first distinct late cause in local observation state; do not log raw paths/content/errors or claim every possible malicious event history was retained. No unrelated resources are kept open to manufacture settlement. A deadline outcome explicitly does not establish cleanup completion.

Preserve exact original and distinct cleanup identities internally, including falsy thrown values. A normal completed destroy with no new failure rethrows the original opening/abort value, or permits the ENOENT decision. Duplicate observation of that same original error is not a second cleanup failure. A synchronous destroy throw or asynchronous destroy error is an additional cleanup failure; still observe closure within the remaining allowance. Aggregate distinct failures in primary/cleanup/deadline order, without replacing the primary. Never use a Promise.race that abandons the losing stream operation or remove its error observer while it can still fail unobserved.

## Evidence

Use real LocalFs roots and actual Node Readable transports in the existing owner test, labeling controlled destroy gates/faults synthetic. Prove helper remains pending before delayed destroy completion, then rejects with the original cause only after closed; prove alternate read has not started while primary ENOENT cleanup is pending, and starts only after closure and a fresh abort check. Exercise abort during pending cleanup, successful transfer, both missing, unchanged ranges, already closed and already destroyed-but-not-closed streams, emitClose:false asynchronous cleanup observed via public closed, synchronous destroy throw, asynchronous distinct cleanup error and ordered primary preservation. Restore instrumentation and settle all controlled stream callbacks in test finally blocks.

One newly named never-settling-destroy/deadline case may use a local 15-second test budget for the actual five-second cleanup policy; no existing/global timeout changes. It must assert no alternate/success, retained primary and deadline outcome, then release its controlled destroy and observe late close/error handling and listener settlement. Do not leave its stream pending merely because the helper returned a deadline failure. Pure controlled-clock cases are supplementary state-machine evidence, not actual resource settlement. Existing tests that awaited close only after helper rejection remain historical weaker evidence; do not rewrite their earlier claims as stronger proof.

## Alternatives and consequences

Rejected: relying on destroy alone; making every arbitrary Readable emit close; a mandatory generic storage-close port; private _readableState/undocumented destroy callbacks; an unlimited wait; or an abandoned timeout race. The chosen bounded observer adds a small cleanup policy to the existing helper. It permits a clearly reported unsettled cleanup failure rather than inventing termination of arbitrary custom IO. No operating-system-wide, unseen-process, individual DROP, model-path, production acceptance or deployment claim follows.
