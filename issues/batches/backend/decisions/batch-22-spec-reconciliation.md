# Batch 22 specification reconciliation

## 1. Required relation.set public-surface expectations

The owner-delegated controller authorizes only the existing `backend/packages/data/src/__tests__/publicSurface.test.ts` path for gh-1521 to add the sorted `setRelationWithClient` runtime export and `setRelation` choke-point method to their exact expected lists. The issue already requires the public export and facade. Keep all other runtime exports, methods, type checks and assertions unchanged. This is test-scope reconciliation, not a relaxed freeze, new production API or altered operation contract.

The original Task, acceptance criteria, transaction/locking and approval semantics are unchanged. The existing public-surface comment permits changes when an issue explicitly changes that public API. All member snapshots remain verbatim, approvals and manifest digests are regenerated. No ADR change, reviewer round, gate or acceptance is introduced. Other members retain their exact scopes.

## 2. Required relation.set MCP contract case

The controller additionally authorizes the existing `backend/services/semprec-api/src/mcp/__tests__/mcpGenericOperationsContract.test.ts` path for gh-1521, limited to its new `relation.set` catalog/listing and actual `tools/call` case, required fixtures and corresponding operation-count comment. Preserve all existing operation cases, human-session and restricted run-credential controls, capability/approval checks and exhaustive typed catalog coverage. The Task already requires MCP exposure; do not omit the new operation or weaken the closed-case assertion to make TypeScript pass.

This is a test-only path addition for gh-1521. Gh-1590's existing permission for the same path does not grant gh-1521 scope by implication. No production transport, operation semantics, transaction/locking or approval policy is changed. All original Task/AC text is preserved with regenerated exact snapshots and approvals. No review or gate is consumed.
