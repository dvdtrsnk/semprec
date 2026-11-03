# Batch 16 specification reconciliation

Authority: owner-delegated controller supervision under the backend program. These decisions reconcile recovered work and exact test scope before dispatch; they do not claim implementation acceptance.

## 1. Append-only subpages decision (gh-1393)

The existing accepted ADR at docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md is the single decision required by this source. Keep its original creation date and permanent path; do not create a duplicate dated today or rewrite its accepted body. Its Decision 3 explicitly amends the page-block text contract of the historical block-model ADR. That is the authoritative amendment record under the append-only convention. It replaces the source's contradictory request to add a retrospective note to the older accepted document. Both accepted ADRs remain byte-identical at dispatch. Verify every required decision, alternative and consequence; any genuinely missing material decision must be reported for an append-only correction, not silently waived. No page implementation is authorized by this ADR-only member. The original handover remains immutable provenance, not acceptance proof.

The recovered gh-1382 ADR likewise retains its actual 2026-10-28 creation date and permanent path. Reconcile the existing decision against all clauses; do not manufacture a second copy solely because this batch executes later. Its client pre-fill remains outside backend implementation scope.

## 2. Existing tick schema and populated upgrades (gh-1557, gh-1354)

The dependency migration 0087_semp_threads_and_messages.sql already supplies heartbeat_id and the exact tenant/heartbeat tick partial unique index. Verifying that delivered schema satisfies Task 1; a duplicate new migration or historical rewrite is not required. Test the actual staged runner boundary and populated legacy state, including the required unique constraint. Any genuinely missing schema repair needs a separately specified additive migration. The existing 0091_session_device_identity.sql is similarly recovered implementation to verify, not rename or rewrite merely to obtain today's ordinal.

Authorize only `backend/packages/data/src/__tests__/migrationCompatibility.test.ts` for those two exact populated upgrade/constraint scenarios, retaining the real staged migration runner and managed transaction ownership. Explicitly name the existing pure userAgentDevice.unit.test.ts for the matcher required by gh-1354. Historical raw fixtures must be justified by their actual pre-migration schema; they are not invented corrupt production records.

## 3. Required Journal transport evidence (gh-1428)

The source explicitly requires both real agent and MCP item.create refusals. Add only the existing genericOperationAgentTools.test.ts and mcpRunCredentialTenancy.test.ts harness paths named in its refreshed Touches for those cases. Preserve the current transport error projection, tenant authorization and no-write semantics; a conflicting error contract must be reported rather than weakened to match a test. Actual REST, Inbox capture and journal-store replay remain required at their existing authorized boundaries. No new production transport or client feature is authorized.

## 4. Finite review and runtime gates

One complete independent grouped audit and one same-reviewer focused bundled repair delta are the maximum automatic rounds. The controller directly disposes remaining findings after that. Incomplete initial inventory resumes the same reviewer on frozen bytes; frozen fixture failures do not reset the budget. Concrete security, data and explicit behavior defects still need correction or an explicit decision. Preserve actual FAIL and NOT RUN results; no earlier local exception transfers. Named exact-SHA stages and complete actual E2E precede an explicit STOP and separately invoked unmodified backend verify. No local integration or guarded completion before candidate-specific controller acceptance.

## 5. Journal refusal domain status and transport envelopes (gh-1428)

The existing accepted 2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog ADR distinguishes domain errors from HTTP transport failures: an authenticated well-formed MCP tools/call maps ChokePointError to HTTP 200 JSON-RPC -32000, preserving its domain code. The actual agent tool maps that same error to an error tool result with the code-prefixed text. Neither transport promises REST HTTP status projection. Therefore the source's agent/MCP “403” means the underlying ForbiddenError domain status, not a new HTTP status or agent result field. Refresh Task 3 and its AC to require the real native envelopes and no item row, while retaining actual HTTP 403 for REST and the hook's original rollback.

Prove the underlying typed error/status at the data boundary and the real agent error result plus authenticated MCP HTTP 200/-32000/data.code forbidden at their named boundaries. Keep auth, approval, tenancy, validation and error ownership unchanged. No new production transport mapping, schema, field or ADR exception is authorized. Earlier tests are development evidence only, not final-SHA acceptance. Correct the rendered migrationCompatibility path in section 2 to its literal **tests** spelling; its already-approved issue Touches never changed. No automatic review round is consumed or added.

## 6. Existing Events cutover harness (gh-1416)

Explicitly authorize the existing backend/packages/data/src/calendar/**tests**/eventsCalendarPropertiesCutoverMigration.test.ts only for gh-1416's fresh seed and actual per-tenant cutover requirements, including unchanged existing Events items/date configuration, identical new property definitions, repeated-run idempotence and absent-Events no-op. Keep the existing approved data/src/**tests** scope as well. Reusing this existing domain harness avoids an unnecessary move or duplicated test. No production path, schema, migration or semantic scope is expanded.

A reconstructed prior property shape must be described honestly as that fixture, use a real production-created Events item and the actual cutover, and preserve historical-data limits; it is not evidence of running a historical deployed binary. The reported targeted PASS is development only and remains subject to the normal exact-SHA named gates. This wording correction consumes no review round and does not authorize another review.

## 7. Actual MCP and tenant realtime harnesses (gh-1373, gh-1395)

Authorize the existing `backend/services/semprec-api/src/mcp/__tests__/mcpHandler.test.ts` for gh-1373 protocol evidence, including real human-session and minted-run-credential initialize equivalence. Authorize `backend/services/semprec-api/src/__tests__/tenantIsolationRealtime.test.ts` only for gh-1395's actual API socket composition: the production after-commit sempThread hook/publisher, tenant-runtime-role positives/refusals, foreign socket exclusion and rollback no-publication. Reuse its owned bounded resources and causal observation rather than inventing a second socket framework. For the agents-style clause, drive the existing shared data hook through its actual publication path; do not claim that an in-process test launches a separate deployed agents service. No production roots, transports, grants, app clients or additional protocol behavior are authorized.

## 8. Initialize persistence versus required authentication touch (gh-1373, gh-1512)

The shared authenticateRequest/verifySessionToken path deliberately updates the valid human session's last_seen_at and sliding expires_at on every authenticated request; gh-1512 in this same batch requires that behavior. It is not handshake persistence. Resolve gh-1373's literal no-write wording to prohibit initialize-owned application/domain state and client/handshake metadata while retaining only that established caller-session touch. Other session fields/rows and relevant domain rows remain unchanged. A run-credential initialize keeps its existing read-only resolution and equivalent response; do not add a human-session touch. Compare actual relevant persisted row contents as well as counts, with a baseline after credential/setup creation; no merely count-based no-write claim. No auth bypass, expiry exception, new storage or production mapping is permitted. Existing authentication/transaction contracts govern; this is a specification reconciliation, not a new ADR pattern.

The aggregate's repeated execution/context prose is shortened solely to stay below its 60,000-character limit. Every embedded source snapshot and current Task/AC remains exact and complete. Review limit and runtime gates are unchanged; no automatic round is consumed or added.
