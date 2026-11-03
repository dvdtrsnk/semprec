# Batch 16 specification reconciliation

Authority: owner-delegated controller supervision under the backend program. These decisions reconcile recovered work and exact test scope before dispatch; they do not claim implementation acceptance.

## 1. Append-only subpages decision (gh-1393)

The existing accepted ADR at docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md is the single decision required by this source. Keep its original creation date and permanent path; do not create a duplicate dated today or rewrite its accepted body. Its Decision 3 explicitly amends the page-block text contract of the historical block-model ADR. That is the authoritative amendment record under the append-only convention. It replaces the source's contradictory request to add a retrospective note to the older accepted document. Both accepted ADRs remain byte-identical at dispatch. Verify every required decision, alternative and consequence; any genuinely missing material decision must be reported for an append-only correction, not silently waived. No page implementation is authorized by this ADR-only member. The original handover remains immutable provenance, not acceptance proof.

The recovered gh-1382 ADR likewise retains its actual 2026-10-28 creation date and permanent path. Reconcile the existing decision against all clauses; do not manufacture a second copy solely because this batch executes later. Its client pre-fill remains outside backend implementation scope.

## 2. Existing tick schema and populated upgrades (gh-1557, gh-1354)

The dependency migration 0087_semp_threads_and_messages.sql already supplies heartbeat_id and the exact tenant/heartbeat tick partial unique index. Verifying that delivered schema satisfies Task 1; a duplicate new migration or historical rewrite is not required. Test the actual staged runner boundary and populated legacy state, including the required unique constraint. Any genuinely missing schema repair needs a separately specified additive migration. The existing 0091_session_device_identity.sql is similarly recovered implementation to verify, not rename or rewrite merely to obtain today's ordinal.

Authorize only backend/packages/data/src/**tests**/migrationCompatibility.test.ts for those two exact populated upgrade/constraint scenarios, retaining the real staged migration runner and managed transaction ownership. Explicitly name the existing pure userAgentDevice.unit.test.ts for the matcher required by gh-1354. Historical raw fixtures must be justified by their actual pre-migration schema; they are not invented corrupt production records.

## 3. Required Journal transport evidence (gh-1428)

The source explicitly requires both real agent and MCP item.create refusals. Add only the existing genericOperationAgentTools.test.ts and mcpRunCredentialTenancy.test.ts harness paths named in its refreshed Touches for those cases. Preserve the current transport error projection, tenant authorization and no-write semantics; a conflicting error contract must be reported rather than weakened to match a test. Actual REST, Inbox capture and journal-store replay remain required at their existing authorized boundaries. No new production transport or client feature is authorized.

## 4. Finite review and runtime gates

One complete independent grouped audit and one same-reviewer focused bundled repair delta are the maximum automatic rounds. The controller directly disposes remaining findings after that. Incomplete initial inventory resumes the same reviewer on frozen bytes; frozen fixture failures do not reset the budget. Concrete security, data and explicit behavior defects still need correction or an explicit decision. Preserve actual FAIL and NOT RUN results; no earlier local exception transfers. Named exact-SHA stages and complete actual E2E precede an explicit STOP and separately invoked unmodified backend verify. No local integration or guarded completion before candidate-specific controller acceptance.
