---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Bracket message speech I/O with a bounded session single-flight

## Context

Gh-1626 needs one cache fill for concurrent first requests to the same tenant/message/voice. A unique completed cache row arbitrates persistence but not calls made before insertion. An in-process promise cannot coordinate API processes. [[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]] forbids keeping a transaction open across the gateway or object store. [[2026-11-01-blob-reference-writes-coordinate-with-collection]] does not yet count the new speech reference.

## Decision

Use one dedicated checked-out PostgreSQL session for a session-level try-advisory lock, held outside transactions across this one cache fill. Derive its domain-separated key from the trusted tenant ID, canonical message UUID and validated normalized voice, never text or a client-supplied tenant. Hash collisions may serialize unrelated keys, never grant access. Capture ownership only when the try-lock succeeds and balance it once; do not reentrantly acquire. A contender polls with cancellation and an absolute deadline, then rechecks the completed cache after acquisition. It does not call the provider while the key is held by another session.

The data speech owner owns the lock/client lifecycle. Acquire with the existing tenant-scoped pool.connect wrapper and retain its session GUC/reset handling. A session error aborts the request and prevents persistence by that owner. Always observe provider/stream settlement and release the lock in finally. Failed or uncertain unlock destroys the client rather than returning a locked session to the pool; preserve primary and cleanup errors. Do not change db/pool.ts or issue manual BEGIN/COMMIT. Short data transactions continue through withTransaction on the data pool, independently of the guard session.

Bound guard-client admission before checkout so held guard sessions cannot consume every data-pool slot while asking that same pool for a transaction. Keep at least one slot available for data work; a pool with no spare capacity fails closed with the existing overload response before provider work. Use named finite admission/operation bounds, no new environment setting. End-to-end waiting/provider/staging has one absolute bound no longer than the existing five-minute speech-client bound; no fresh full timeout per phase. A cancelled waiter never unlocks another request's session. The guard is released after cache persistence/cleanup settlement and before streaming cached bytes to a slow client.

First authenticate and validate thread/message association and nonempty usable text in a short transaction. After acquiring the key, reread association, text and cache in a new managed transaction. Call only the existing gateway speech client outside transactions and stream its bounded output to a unique tenant-prefixed standalone blobs key in the Files root, using the existing BlobStorageWriter byte cap and actual PCM format. A raw output must not be labeled as MP3. Finalize in a short READ COMMITTED transaction: reserve the source message, recheck thread/tenant association and exact captured text, then create the blob and cache row atomically. Use message-before-blob ordering and tenant-composite message/blob foreign keys. A deleted/changed source cannot acquire a cache entry from stale output. Do not overwrite a completed winner; discard only this attempt's private staged key if its row is not committed. No provider or storage I/O occurs in the final transaction.

The sole user of a tenant is enforced by users_tenant_id_key (migration 0056); threads have no independent user_id. Authenticate the real session and use its tenant plus existing tenant-user contract. Another user's thread is tested through another tenant, together with random and mismatched-thread controls, all producing the same 404. No multi-user ownership schema or fake same-tenant second user is introduced.

## Cache and bytes lifecycle

The cache row cascades with its message and therefore with its thread. Its tenant-composite blob foreign key must not cascade deletion from a blob into a valid cache row. Extend only blobsStore.deleteBlobIfUnreferenced's reference predicate to retain speech-referenced blobs; keep the existing blob lock followed by a fresh READ COMMITTED reference scan. This extends, rather than replaces, the existing item/mail/Inbox reference rules. Final cache insertion's blob FK/locking participates in that deletion ordering.

After the last cache reference cascades away, an otherwise unreferenced standalone blob is eligible for the existing age-gated unreferencedBlobSweep. That owner deletes the row transactionally and then awaits physical-byte deletion after commit under [[2026-09-28-blob-bytes-deleted-best-effort-after-the-commit]]. Row cascade is immediate; physical reclamation is eventual and best effort, not part of HTTP deletion success. Do not repurpose deleteDerivedBlob or delete shared/deduplicated bytes directly. Ordinary failed fills clean only their known private staged key after rollback; failure after a committed cache must never delete its bytes. A crash before row registration may leave unreachable staged bytes, an explicit storage-reclamation limit of the existing model, not grounds to delete unobserved keys or invent a new sweep.

## Failure limits and evidence

One live lock-holding session excludes a second fill for that key. A process/session loss may release the lock while the external provider is still working, so exactly-once synthesis across crashes or lost sessions is not claimed. A later retry may call the provider again. Unique cache persistence and source revalidation still arbitrate the database result. No automatic claim expiry, fencing, provider idempotency promise or new background job is introduced.

Prove two independent request/connection instances sharing a key call the real gateway composition once with provider transport injected; prove cached reuse, bounded contention/cancellation, failure cleanup, source deletion while the provider is held, and no false cache success. Separately prove a live speech reference survives collection, cascade removes the reference, existing unrelated references retain shared bytes, and actual eligible last-reference collection removes bytes after commit. Preserve source/cache/blob state on rollback. The route uses a real binary streaming listener registered in app.ts and the route/tenant catalogs, not a JSON adapter pretending to stream. No live provider or host changes are authorized.
