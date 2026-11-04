# Batch 22 specification reconciliation

## 1. Required relation.set public-surface expectations

The owner-delegated controller authorizes only the existing `backend/packages/data/src/__tests__/publicSurface.test.ts` path for gh-1521 to add the sorted `setRelationWithClient` runtime export and `setRelation` choke-point method to their exact expected lists. The issue already requires the public export and facade. Keep all other runtime exports, methods, type checks and assertions unchanged. This is test-scope reconciliation, not a relaxed freeze, new production API or altered operation contract.

The original Task, acceptance criteria, transaction/locking and approval semantics are unchanged. The existing public-surface comment permits changes when an issue explicitly changes that public API. All member snapshots remain verbatim, approvals and manifest digests are regenerated. No ADR change, reviewer round, gate or acceptance is introduced. Other members retain their exact scopes.
