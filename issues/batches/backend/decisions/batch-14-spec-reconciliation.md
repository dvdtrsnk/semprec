# Batch 14 specification reconciliation

Owner-delegated controller `thr_pz39tcih5r` records these bounded decisions before implementation. Source issues, aggregate snapshots, manifest digests and current approvals change together. No acceptance, completed test result or release is implied.

## 1. gh-1460 dependency plumbing and unavailable mailbox control

Task 3 requested a proxy forwarding to the live-sync root after construction. The actual root exposes `start`, `stop`, `reconcileOnce` and `stopTenant`, with no per-mailbox methods. The accepted `2026-10-29-custom-route-composition-root-dependencies` ADR explicitly selects a placeholder that refuses `startMailbox` and `stopMailbox` with `CustomRouteConfigurationError` until a later change provides those controls. Its historical body remains unchanged.

Retain that existing architecture and correct Task 3 to it. Deliver the typed optional container, request-time dependency lookup, factory/dispatcher propagation and existing environment configuration. The production placeholder must fail clearly when called; it is not working per-mailbox lifecycle control and is never reported as forwarding successfully. Test substitutes may implement the interface to prove actual dependency delivery and invocation. Do not add root lifecycle APIs, use global `reconcileOnce` for both operations, change shutdown or invent ownership/serialization for mailbox controls. A future consuming-route/lifecycle change must define the real control contract before relying on it. This is a reconciliation with an already explicit accepted decision, not a new lifecycle protocol or exception requiring a replacement ADR.

All four member AC remain binding. Missing dependency failures must remain per request, without breaking unrelated routes at startup. Current live-root behavior is not evidence of future control success.

## 2. gh-1433 actual color-operation boundaries

The AC explicitly names REST, `/mcp` item operations and proposal confirmation. Existing data-only tests do not prove those transports. Add precisely `services/semprec-api/src/__tests__/itemsHandler.test.ts` for real authenticated REST and proposal-confirm color cases, and `services/semprec-api/src/__tests__/mcpRunCredentialTenancy.test.ts` for actual MCP `tools/call` operations. Paths are under `backend/`.

These additions are test-only and limited to the existing color validation contract: accepted hex/null cases, rejected invalid color with the required field and preserved persisted state, and the declared untouched legacy-color exception where applicable. Preserve authentication, tenant isolation, real operation dispatch, original tests and production guards. Do not substitute a direct helper for the named boundary or expand into unrelated harness refactoring. The Task and AC behavior is unchanged.

## 3. gh-1359 approved archive and queued rollup effects

Explicitly authorize `backend/packages/application/src/__tests__/genericOperationGateway.test.ts`, whose existing `database.archive` case executes actual preflight, approval and replay. Extend only that scenario/nearby focused cases with legitimate count/sum dependencies, actual enqueue/recompute and persisted effects required by gh-1359. Retain direct archive/restore coverage in the already named data tests. Calling `databaseArchiveWithClient` alone is not the approved-operation assertion.

Use existing production queue composition and bounded owned settlement. Do not change approval policy, queue architecture or unrelated fixture cleanup. No new public production export or cross-package test framework is authorized by this test-path addition. Source Task/AC behavior is unchanged.

## 4. Review and evidence limits

The owner's two-round automatic review cap remains mandatory for the whole batch. These pre-implementation scope reconciliations do not consume or reset that budget. Development runs are development evidence; final exact-SHA named targets, separate full verify and actual E2E retain their real results. No earlier candidate or batch exception transfers.
