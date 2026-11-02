# Batch 12 specification reconciliation

## 1. Item-link guard and future write consumers

Owner-delegated controller thr_pz39tcih5r confirmed on the batch-12 base that
`assertItemLinksExist` has no production write caller. The shared parser is pure;
the current journal caller is read-only. Original gh-1614 handover states this
limitation and is preserved, not accepted as a waiver.

Gh-1614 now explicitly delivers the pure item-link format/collection and the
backend guard contract with actual parsed-block, runtime-role two-tenant tests.
Unknown, foreign, deleted and malformed targets must give the same safe typed
400 validation contract, with a live local positive and no document/relation
writes. Add no REST/MCP endpoint or database I/O in the shared parser.

Actual page-write invocation and authenticated HTTP response assertions are
assigned explicitly to existing owners gh-1679 (batch38) and gh-1765 (batch47).
Their prerequisites, Tasks and AC now require the guard on the write client,
whole-write rollback on refusal and real positive/unknown/foreign/deleted/invalid
HTTP controls. Their future aggregates/manifests are refreshed but remain
proposed; this is not authorization to execute them now. Current batch-12
evidence must say HTTP integration NOT RUN, not infer it from helper exceptions.

The additive ADR is
[[2026-11-02-markdown-item-links-are-validated-by-tenant-write-owners]]. Accepted
historical ADR bodies, all original handovers and worker's unrelated dirty AI
usage implementation are unchanged. No missing implemented endpoint is
represented as passing. Batch-12 implementation/review/runtime gates remain.

## 2. Actual automatic retry evidence

Gh-1458 explicitly includes the existing `backend/packages/data/src/__tests__/scheduler.test.ts` harness for actual sweep-to-queue-to-worker automatic attempt chains. Direct action calls with synthetic attempts are supporting tests, not that composed execution. Preserve real attempt counters and final-notification rules; public rescheduling may accelerate only the owned job. No production scheduler, queue retry policy or unrelated test cleanup is added by this path reconciliation.

## 3. Populated migration evidence harness

Gh-1448, gh-1458 and gh-1438 explicitly include the existing `backend/packages/data/src/__tests__/migrationCompatibility.test.ts` for their already required populated historical upgrades. Use isolated owned databases and the actual staged migration runner: populated pre-retry runs retain attempt1/null predecessor; occurrence migration preserves existing runs with null occurrence; pre-origin heartbeats retain fields and gain system origin. Prove the applicable constraints and compatible legacy reads/writes without rewriting historical migrations or inventing historical data provenance. Existing store and runtime-role tenant/foreign-key tests remain required. This is a test-path reconciliation only, not a new migration/lifecycle contract, schema change or permission to refactor unrelated old fixtures. Newly used resources need bounded owned cleanup and preserved failures under the existing testing/error rules.

## 4. Pure catalog test tier

Gh-1442 and gh-1477 name the pure model/operation label suite as `backend/packages/data/src/aiGateway/__tests__/modelDisplayNames.unit.test.ts`, conforming to the existing filename-selected unit tier. Rename the recovered `.test.ts` file, preserving all model/operation/catalog assertions and no-DB imports; do not leave a duplicate integration suite or modify tier configuration. Actual usage-route integration tests remain required. This corrects the path to the already specified no-database test behavior, not its functional scope.

## 5. Summary and gateway budget composition

Gh-1456 explicitly includes `backend/packages/ai-gateway/src/__tests__/gateway.test.ts` only for its combined summary/accounting/refusal criteria. This existing harness uses actual PostgreSQL accounting with local fake providers, not mocked stores. Use explicitly scoped runtime roles: real reservations at the tenant daily cap must appear in the summary with the required reset and cause the next gateway call to be refused without invoking its provider. Prove operator-only global-cap refusal while the visible tenant summary remains unexhausted, with an admitted positive and no operator-cap disclosure. Preserve existing data summary tests, tenant isolation and budget semantics; no production gateway/accounting change, extra dependency, live call or generic test framework is authorized by this path addition. Other findings still require their actual Task scope.
