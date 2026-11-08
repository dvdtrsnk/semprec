---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Keyed after-commit effects belong to the managed invocation

## Context

Gh-1621 needs one final relation event per item/property key in a transaction. A separate client-keyed pending map cannot observe rollback disposal and may survive pooled-client reuse. [[2026-09-10-side-effects-follow-the-commit]] and [[2026-09-29-withtransaction-is-the-sole-transaction-opener]] assign callback draining/disposal to pool.ts. Its existing active TransactionOwner identifies the actual invocation.

## Decision

Add an internal runAfterCommitKeyed(client, namespace, key, callback) facility in pool.ts, not a data public-barrel export. Registration requires the exact active managed client, using the existing owner check. Each owner holds its own keyed registration state. A private module Symbol is the namespace; relationOps encodes the itemId/propertyKey tuple unambiguously (JSON array encoding, including null). The first registration reserves one position in the existing after-commit callback sequence; later registration with the same namespace/key replaces the callback in that slot, keeping the last complete event, including op and optional user restriction. Different keys/namespaces remain independent.

The same withTransaction invocation owns disposal after body failure, rollback, COMMIT failure and terminal callback processing. No keyed state survives into a later transaction on the pooled client. Detached work with an inactive owner cannot register. Keep existing unkeyed runAfterCommit behavior, transaction opening/isolation, commit/rollback order, primary/secondary error behavior, callback failure isolation and client-release behavior unchanged. No hand-rolled transaction or new lock is introduced. This extends the existing lifecycle owner rather than moving it to relationOps.

## Consequences

Relation invalidations can collapse repeated writes without a separate client-lifetime cache. The first callback position and last callback payload are deterministic; this is not durable delivery, cross-transaction deduplication or a new concurrency fence. Test replacement/order, different namespaces/keys, unmanaged/mismatched admission, callback exceptions, body/COMMIT failure, and same-client reuse after rollback and successful commit. Real relation tests verify after-commit emission and absence after rollback under tenant scope.
