---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Give the reference expander sole ownership of transferred blob streams

## Context

[[2026-11-06-blob-open-cleanup-observes-stream-closure]] ends its stream ownership at successful transfer. Gh1740/1752's refExpansion and refImage previously both called destroy in finally; neither separately established post-transfer closure. The earlier helper tests cannot prove a caller's settlement. [[2026-11-06-agent-images-use-bounded-ephemeral-payloads]] selects ephemeral decode/resize and real input-byte bounds, not two competing owners of one readable.

There are two actual consumers of the same closure policy: data's open helper and agents' post-transfer ref read. Copying the observer into both would create divergent deadline/error handling. Importing data into a pure image unit helper would violate the test tier and package direction. A default async iterator can also wait on destruction while returning early; cleanup cannot be deferred until after an indefinitely waiting iterator return. This decision changes only these existing reference paths.

## Ownership and shared primitive

Extract the existing closeOwnedStream closure-observation machinery from data's openBlobFromRoots.ts into packages/shared/src/settleBlobReadStream.ts. The existing shared index may export only settleBlobReadStream, BlobReadCleanupError and the BlobReadCleanupBudget type needed by the two owners. Add its pure **tests**/settleBlobReadStream.unit.test.ts. Import Readable type-only; no runtime Postgres/data/agent import, module-level IO, host initialization, new dependency or package export-map change. This is one concrete blob-read cleanup primitive used by those two paths, not a general resource registry, configurable IO framework or new storage port.

Preserve the existing five-second absolute cleanup allowance, at-most-10-ms public-closed checks, event-loop qualification, observer handoff, error identities, bounded late observers and explicit deadline-failure policy. It has no abort shortcut, invented closure, global registry, continued late polling, private stream state or undocumented destroy callback. The data helper retains its one allowance across its roots and all current ENOENT/abort/transfer behavior. Ref expansion starts a separate allowance only when it first cleans the stream it actually received; it cannot access or restart the opener's prior ownership phase. No single allowance is claimed across the two separate owners. Do not change the already selected open behavior while extracting the primitive.

Use an explicit optional tagged primary failure, such as {error: unknown}, rather than interpreting undefined as no failure. With no primary failure and successful closure, cleanup returns normally. With a primary failure but no distinct cleanup failure, cleanup returns so its caller can rethrow or classify that exact original value. With any distinct cleanup failure or deadline failure, throw BlobReadCleanupError extending AggregateError: errors contain the supplied primary first if present, then distinct cleanup errors, then deadline error; cause is the supplied primary when present, otherwise the first cleanup error. Preserve falsy values and do not duplicate the same observed primary. The type must distinguish a cleanup failure from ordinary content failure without error-message matching. Retain current bounded first-secondary/late-observation limits; do not promise an unbounded malicious error history.

## One post-transfer owner

RefExpansion owns each returned stream from receipt until closure is observed or the explicit cleanup deadline failure is raised. Attach a bounded error observer before reading and retain it through cleanup-observer handoff. Read bytes under the actual 10 MiB text or 16 MiB image cap, with typed chunks and the existing turn signal. A narrowly private listener-based read in existing refExpansion.ts may observe data/end/error/close/abort, pause and detach its own data handlers on termination, and settle its local read outcome. It must register terminal/error/abort handlers before starting flowing data, handle already ended/closed/destroyed state and abort races, and never leave an outstanding iterator next/return blocking entry to cleanup. This is local byte consumption, not a new public port/helper or a model substitute.

After the read outcome is known, await the shared cleanup primitive before returning that ref's successful text/image to the turn. On abort, oversize, invalid chunk, premature close or read error, cleanup still runs. Retain observed read failures through the handoff; destruction is initiated by the one owner, not independently by two finally blocks. Once bytes and closure are settled, extraction/UTF-8 decode and image decode can work from the bounded Buffer outside database transactions. A completed buffer does not contain a still-owned source stream. There is no DB transaction over byte/native IO and no expanded write.

RefImage's existing decodeRefImage now accepts the bounded Buffer instead of a Readable, preserving its defensive input-byte check, signatures, pixel/output/side limits, fixed quality and awaited five-second sharp processing timeout. It owns the awaited native decode/resize work only; it has no stream destroy/abort listener. Cancellation checks before and after native work remain, with no abandoned native promise or claim of a hard wall deadline. Its existing pure unit tests use actual buffers and decoder fixtures; stream read/close controls belong to the expander/shared owners. No model input, replay-carrier, provider, upload/MIME or persistent-image change is introduced.

## Ordinary content failure versus cleanup failure

Ordinary per-ref missing/unreadable/unsupported/extraction/decode failure remains an unavailable placeholder after successful cleanup; the turn can continue as the source Tasks require. A null image result is such an ordinary outcome. Keep actual current metadata labels and ref-only context under the preceding normalization decisions.

A BlobReadCleanupError is infrastructure failure, not an ordinary unavailable ref. It must escape every refExpansion catch and stop expansion before a model call uses the partial result. Do not continue to the next ref, return text/images accumulated as success, hide it under a generic placeholder, or replace it with signal.throwIfAborted. Preserve the primary/cleanup ordering. When an operation already failed before cleanup, that captured outcome remains primary. With successful cleanup, propagate an already-aborted turn instead of converting it into a placeholder; a cancellation first noticed after successful operation/cleanup uses the existing signal reason. No new worker error taxonomy, model repair or public error body is selected.

This is an explicit narrow exception to the earlier absolute wording that every ref/extraction failure or unloadable image lets the turn continue: that rule is for ordinary content failure with successfully settled owned IO. Cleanup failure, including unobserved closure at deadline, is fatal to this expansion. The affected source Task/AC wording is reconciled accordingly; no other feature criterion is waived. At expiry, retain the bounded late observation and admit that closure is unproved, as the opener ADR already does. A later close does not retroactively make the failed turn successful.

## Evidence and limits

Move/reuse the shared observer's real Readable controls without losing data-helper regressions. Prove normal no-primary cleanup, thrown undefined/null/false, distinct synchronous/asynchronous cleanup failure and deadline error ordering, already closed, destroy-pending, emitClose:false, absolute allowance and bounded late error/close. A newly named actual five-second stalled-cleanup case may use a local 15-second test budget; release and settle its own stream afterward. Existing/global timeouts and decoder budgets do not change.

In the existing actual runtime-role refExpansion.test.ts, use production metadata/read/byte owners with real LocalFs and already allowed controlled transport streams. Prove successful text, plain invalid UTF-8, image, early over-cap/invalid bytes, abort and read failure observe closure before success/placeholder/throw. Hold destroy completion deliberately and assert expansion remains pending; then release actual cleanup. Inject a bounded controlled cleanup failure/deadline separately and assert typed fatal escape, no subsequent ref read and no successful image/text return. Strictly delegating existing storage read transport instrumentation can observe actual close on the new real mail fixture; no metadata/expander/model/dispatcher replacement. Existing refImage unit tests remain pure Buffer/decoder evidence. Do not label these as a real queued worker/native model or successful replay scenario.

Prior model FAIL/UNKNOWN, Pages follow-up, finite proof limits, missing PGID records, historic lint/test failures and no unseen-process/individual DROP claim remain. No live provider, independent review, final verify, acceptance or deployment is authorized by this decision.

## Alternatives

Rejected: treating destroy as settlement; accepting a cleanup failure as a normal placeholder; duplicating the observer in agents; importing data into the pure image decoder; retaining competing stream owners; or racing an unobserved iterator/native operation. The cost is a narrow shared pure cleanup primitive and one local bounded-byte reader. Existing storage and persistence owners remain unchanged.
