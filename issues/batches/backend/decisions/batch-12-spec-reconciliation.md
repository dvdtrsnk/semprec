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

## 6. Authenticated usage response and locale composition

Gh-1472 and gh-1477 explicitly include the existing `backend/services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts` for actual authenticated GET /api/ai-usage response evidence. Preserve direct data-handler tests and foreign exclusion. Use the differing Diarizace/Diarization label to discriminate authenticated locale propagation; Sonnet has the same label in cs/en. Assert the original byModel merged breakdown and applicable operation-label response contract with runtime tenant isolation. No new response field, locale policy, client, provider call or unrelated fixture redesign. Count/cost/unit and legacy-field compatibility remain binding.

The aggregate was near its60000-character metadata limit. Only its repetitive top-level Context was compressed; every embedded source Context/Task/decision/Touches/Scope/AC remains complete and snapshot-verified. The initial source-only metadata commit preceded the corrected aggregate/manifest; the final validated refreeze is the authority, not that intermediate state.

## 7. Repeatable flat AI-usage catalog output

The literal gh-1442 cp-r directory command nests the source when its destination already exists on this host; matching current outputs alone does not establish refresh. Use `mkdir -p dist/aiGateway/i18n && cp src/aiGateway/i18n/*.json dist/aiGateway/i18n/` for this area only, consistent with the previously corrected auth-area build pattern. Preserve all other build commands and source catalogs. Prove two actual package builds, with only owned ignored output JSON made stale between them; top-level cs/en output bytes must match current source after both. Retain the owned temporary negative reproduction separately. No live provider, global build cleanup, unrelated catalog sweep or new framework. No source-file changes during a frozen gate; this is development verification before the final candidate freeze.

## 8. Bundled initial independent review repairs

The complete initial review of candidate 24e0f0f65501f24a62ce8c84f4418e8bc6bd8187 is NOT CLEAR with three medium findings; its read window is released. This coordinated scope accepts those findings, not the candidate. Preserve the report and all original handovers.

For gh-1472/1477, adopt [[2026-11-02-ai-usage-report-aggregates-share-one-statement-snapshot]]. Include accountStartedAt: its MIN(call.at), together with the tenant-user minimum and existing LEAST/fallback, affects monthly zero fill. Keep the public Queryable API and perform database-side grouped aggregation in one statement for all call-dependent output. Timezone/budget/catalog metadata retain their existing separate contracts. SQL numeric merged costs and total precede conversion to public numbers; equality does not mean arbitrary binary-number reductions are bit-identical, and no currency scale/rounding policy is introduced. Preserve each existing component's failed/status/unit/range/order rules. Validate new DB/JSONB shapes and exercise actual runtime-role concurrent accounting states and fractional amounts in the existing usage integration test. No new endpoint, pool API, writer lock, cache, migration or provider call.

Replace the newly added manual pooled transactions in agentRunsStore.test.ts, heartbeatManualTrigger.test.ts and the historical batch-12 migrationCompatibility.test.ts seed with withTransaction. This applies the existing transaction-owner ADR, not an exception to it. Preserve actual operation-owned PIDs, exact blocker checks, historical schema/tenant fixture and final assertions; bound setup, coordination and complete owned settlement, preserving primary and secondary failure identities.

Repair only the new gh-1453 authenticated HTTP/worker fixture and its finite failure controls in tenantIsolationRoutes.test.ts. Use dedicated owned worker/pool resources with bounded checkout/statements and the existing queue lifecycle; release gates, stop/drain and await owned work before restoring hooks or closing resources. Prove supported pre-action blockage/failure cleanup as well as success; a timeout alone is not cancellation or settlement. Do not alter production queue/scheduler behavior, shared global test setup or introduce a general fixture framework. These exact existing test paths are already in the relevant members' Touches.

Correct gh-1472 AC2 evidence attribution: unknown-model fallback is direct integration evidence; authenticated HTTP exercises Sonnet and locale-discriminating diarization, not the unknown model. Carry gh-1448's conflict-arbiter audit in the local receipt, without inventing a PR. Static/deferred/live/device statuses remain explicit. The aggregate's repetitive top-level Context alone is shortened for the metadata size limit; embedded source snapshots remain complete.

After the bundle's development checks and clean checkpoint, retain the same reviewer for the actual delta and independently byte-reconciled complete ledger. Unchanged bindings need not be rediscovered from scratch. No final gate or completion is authorized by a partial review. Exact-SHA targets and manifests must stop before separately invoked full verify; prior-batch exceptions do not transfer.
