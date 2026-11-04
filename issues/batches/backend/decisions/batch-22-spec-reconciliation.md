# Batch 22 specification reconciliation

## 1. Required relation.set public-surface expectations

The owner-delegated controller authorizes only the existing `backend/packages/data/src/__tests__/publicSurface.test.ts` path for gh-1521 to add the sorted `setRelationWithClient` runtime export and `setRelation` choke-point method to their exact expected lists. The issue already requires the public export and facade. Keep all other runtime exports, methods, type checks and assertions unchanged. This is test-scope reconciliation, not a relaxed freeze, new production API or altered operation contract.

The original Task, acceptance criteria, transaction/locking and approval semantics are unchanged. The existing public-surface comment permits changes when an issue explicitly changes that public API. All member snapshots remain verbatim, approvals and manifest digests are regenerated. No ADR change, reviewer round, gate or acceptance is introduced. Other members retain their exact scopes.

## 2. Required relation.set MCP contract case

The controller additionally authorizes the existing `backend/services/semprec-api/src/mcp/__tests__/mcpGenericOperationsContract.test.ts` path for gh-1521, limited to its new `relation.set` catalog/listing and actual `tools/call` case, required fixtures and corresponding operation-count comment. Preserve all existing operation cases, human-session and restricted run-credential controls, capability/approval checks and exhaustive typed catalog coverage. The Task already requires MCP exposure; do not omit the new operation or weaken the closed-case assertion to make TypeScript pass.

This is a test-only path addition for gh-1521. Gh-1590's existing permission for the same path does not grant gh-1521 scope by implication. No production transport, operation semantics, transaction/locking or approval policy is changed. All original Task/AC text is preserved with regenerated exact snapshots and approvals. No review or gate is consumed.

## 3. Member-specific AgentTool contract cases

The controller authorizes the existing `backend/packages/agent-runtime/src/__tests__/genericOperationAgentToolsContract.test.ts` test path separately for two member obligations. For gh-1521, add only the `relation.set` listing and actual immediate replacement AgentTool case, required single-valued relation fixture and operation-count comment. Preserve the exhaustive typed catalog and all existing destructive/pending-approval and capability controls. For gh-1590, add only `item.create.relations` schema acceptance and actual create-with-relations AgentTool evidence with the required fixture. The latter permission does not broaden relation.set scope and vice versa.

Both are required native adapter evidence for already-specified operations, not new tool exposure or approval semantics. All current Task/AC text, transaction and locking requirements remain unchanged. No production helper, source export, transport or runtime test hook is authorized by this test-path addition. Current member snapshots, approvals and plan hashes are regenerated together.

## 4. Existing item.patch test carrier narrowing

Gh-1521 adds an intentionally nullable relation.set output to the generic operation union. The controller authorizes only `backend/packages/agent-runtime/src/__tests__/genericOperationAgentTools.test.ts` to narrow the existing item.patch mock output to a non-null object before `Object.getOwnPropertySymbols` and the existing missing/invalid classification-carrier mutations. Unexpected null or non-object must fail immediately; do not bypass assertions, add unchecked casts/non-null assertions or change production gateway/carrier behavior. Preserve all current carrier count, mutation, privacy and result assertions.

This is a narrow test type-compatibility consequence of the specified relation.set null-on-clear output. All Task/AC and operation contracts remain unchanged; no production API, architecture, error policy, review or gate is added.

## 5. Required item.create-with-relations public-surface expectations

For gh-1590 only, the controller authorizes the existing `backend/packages/data/src/__tests__/publicSurface.test.ts` path to add sorted `createItemWithRelationsWithClient` to the exact runtime-export list and `createItemWithRelations` to the exact choke-point-method list. The Task already requires that write entry point, barrel export and facade. Keep every other expected entry, assertion and frozen type check unchanged. Do not derive expected lists dynamically or relax exact equality.

This permission is separate from gh-1521's relation.set expectations and does not alter either member's Task/AC, public API beyond its required entry point, transaction, rollback, idempotence, owner or relation validation contract. No new architectural decision, review or gate is introduced.

## 6. Gh-1621 transaction-owned deduplication and payload bounds

Use [[2026-11-04-keyed-after-commit-effects-belong-to-the-managed-invocation]] for the internal keyed callback facility in pool.ts and its focused pool.unit.test.ts controls; relationInvalidation.test.ts already owns actual relation/pooled-client/rollback evidence. No public barrel export or transaction-policy rewrite.

Use [[2026-11-04-oversized-relation-keys-request-a-full-link-refetch]] for an explicit 7000-byte serialized relation-message budget and propertyKey:null full incoming/outgoing-link refetch fallback, preserving all IDs/op/user restriction and PostgreSQL-derived tenant envelope. Existing protocol/publisher/socket/client-contract test paths cover it. Task3/6 and affected Task1/7/AC are reconciled literally; no claim that arbitrary exact keys fit PostgreSQL. All other member requirements stay unchanged.
