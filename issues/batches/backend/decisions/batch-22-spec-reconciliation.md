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

## 7. Actual REST and agent relation-to-socket composition

For gh-1621, authorize the new `backend/services/semprec-api/src/__tests__/relationRealtimeIntegration.test.ts` harness. Compose the real API dispatcher, authenticated REST write and actual generic agent gateway with the real sync server/publisher and asserted non-bypass tenant business pool. Verify actual frames at owner/foreign sockets, acting-user restriction, after-commit and rollback, and the already required move/end/one-way/dedup or oversized-key cases where this composition is necessary. Fixtures and bounded local socket/notification cleanup belong to this test. New listeners bind loopback.

Preserve all existing agent approval policy: a destructive agent delete must use its real approval/confirmation path or be explicitly distinguished from a direct domain caller, never bypassed to manufacture agent evidence. An immediate relation.set remains governed by gh-1521. Keep owner-positive and foreign no-effect controls discriminating with ordered sentinels, not a sleep alone. This path supplies evidence for the existing Task/AC, not new production behavior. Do not add downstream dependencies to the realtime package, cross-package private imports, new production exports/hooks, live providers or client application work. Other member scopes and the two lifecycle/payload ADR contracts remain unchanged.

## 8. Isolated gateway/provider, worker and socket evidence

The controller separately authorizes gh-1469 and gh-1475 in the new `backend/services/semprec-transcribe/src/__tests__/transcriptionGatewayComposition.e2e.test.ts` E2E owner. Gh-1469 proves actual prepare/finalize duration/time and a second tenant-owned device socket receiving the resulting Transcripts invalidation, with foreign no-effect and repeat stability. Gh-1475 proves the real Whisper provider parser mapping czech to cs, actual authenticated gateway HTTP response, real transcribe HTTP client/queued task, both Files/Transcripts cache values and later-chunk cs request. Preserve existing budgets, tenant scope and queue ownership; provider network is stubbed only at its outbound boundary.

The transcribe harness imports only its own task and supported core entry points. Start a gateway-owned compiled fixture at `backend/services/semprec-ai-gateway/src/__tests__/fixtures/transcriptionLanguageGateway.ts` as an owned child process; that fixture may import its own dispatcher/provider modules. Communicate through local HTTP plus bounded validated readiness/control IPC, never service-to-service imports, even via public entry points. It runs the actual gateway dispatcher and DeepInfra Whisper adapter, replacing only the exact outbound provider fetch with an owned loopback stub response. Reject unexpected external destinations. Other model/diarization/summary dependencies may use existing local stubs; do not claim them as live evidence.

Reuse the existing test-only compiled workspace resolver and block-model fixture setup with only the required @semprec/ai-gateway dist entry added. Record actual compiled artifact hashes, argv/PIDs/readiness and settlement; the resolver is disclosed test infrastructure, not proof of native production packaging. No new service public export, import-boundary exemption, production dependency, runtime hook or toolchain setting is authorized. Transcribe package and lockfile changes are limited to ws/@types/ws test devDependencies if direct socket use needs them. The driver may reuse its own media fixture helpers; no foreign private-source imports. Restore temporary test environment changes, isolate fetch interception in the child, use loopback listeners and owned resources with failure-path cleanup.

Both member Task/AC bodies remain intact, and each file permission applies only to its stated assertions. This adds a genuine E2E file to the actual E2E tier and complete final E2E run, not an integration-tier pass by filename manipulation. No review round or gate is introduced by scope approval.

## 9. Bounded audio base64 prerequisite for real chunk evidence

The parent independently extracted the actual original audioHandler BASE64_PATTERN and reproduced a RangeError on synthetic valid 8,000,000/16,000,000-character inputs under the current Node; 4,000,000 was accepted. Storage report parent-base64-original-reproduction.json records it. This proves that validator defect, not the unobserved stack or complete cause of the earlier E2E failure.

Gh-1475 gains an explicit corrective Task/AC, limited to audioHandler.ts and its existing audioHandler.test.ts. First reproduce the large-valid failure through actual local audio routes with existing fake providers; then replace only validation with a bounded linear scan over ASCII alphabet, total multiple-of-four length and final padding grammar. Preserve exactly the old accepted syntax, including its existing unused-padding-bit behavior; Buffer decode/re-encode canonicalization must not silently tighten it. Empty input retains its existing separate refusal. Keep body cap, authentication, budgets/accounting, response shape, provider interfaces and decoded bytes unchanged. No regex with stack growth, cap reduction, body-size bypass, fake duration or altered real chunk size.

Controls cover both real audio routes for a valid input at or above 8,000,000 characters, large invalid tail and representative alphabet/length/padding failures with provider no-call assertions. Run complete affected audio tests and the real queued multi-chunk E2E after the bounded fix. Preserve every failed diagnostic; only actual observation can attribute the prior E2E failure. This hygiene repair follows existing I/O-bounding rules and adds no architecture, provider, dependency or review round. Only redundant aggregate outer Context and Task boilerplate are condensed if required by its model-size bound; all member snapshots and other Task/AC text remain verbatim.

## 10. Non-API worker relation frame

For gh-1621 only, authorize the existing `backend/services/semprec-transcribe/src/__tests__/transcriptionGatewayComposition.e2e.test.ts` to observe the actual queued transcription worker's persisted Event/transcript or proposal sourceTranscript edge and its resulting relation frame at the owner device socket, with an ordered foreign-tenant no-event sentinel. Use the supported real matching/creation path and verify the frame against the committed edge/endpoints/property. No fabricated frame or direct publisher call may substitute for the worker-caused relation event.

This completes the already specified non-API process composition evidence by reusing the gh-1469/1475 driver. It adds no production dependency, hook, gateway/provider fixture behavior, new event semantics or client application work. Existing member-specific permissions remain separate. Only a redundant outer aggregate rationale sentence may be shortened for its model limit; all current source snapshots and substantive requirements remain verbatim.

## 11. Expanded blob metadata map, not per-property arrays

The current gh-1518 Task1 array phrase conflicts with both gh-1412's canonical ItemEnvelope map and the existing accepted choice in issues/decisions/gh-1518.md, which explicitly rejects per-property arrays. The controller selects the already-decided optional top-level blobs[propertyKey] map on ExpandedRelationTarget: visible projected blobs only, metadata containing blobId, numeric byteSize, mimeType and nullable filename; unchanged projected property values and omitted empty map. Task1 and its file/image AC are reconciled literally with that contract. No compatible production output is to be changed to an array, and no live binary/previous-release behavior is inferred from handover text.

The old gh-1518 decision, gh-1412 source and handover remain byte-identical; both old/source contract references are bound in dispatch context. This correction does not import unrelated historical decision changes into the current Task, add paths, alter the batched SQL requirement or relax boundary/tenant validation. Existing approved module/test paths verify ordinary, projected/hidden/null and empty omission behavior. Only redundant outer aggregate Context is compacted if necessary; every current source snapshot remains verbatim. No new architecture, review or runtime gate is introduced.

## 12. Exhaustive route-to-handler boundary entry

Gh-1521 explicitly adds the set relation REST route in routeMatrix. The actual development boundary suite rejects its missing handler mapping. Authorize only `backend/services/semprec-api/src/__tests__/chokePointWriteBoundary.unit.test.ts` to add `"set relation": "services/semprec-api/src/itemsHandler.ts"` adjacent to the other relation entries in ROUTE_HANDLER_FILES. Retain all existing entries, exhaustive route matching and scanned-handler/dependency checks. Gh-1509's existing self-person permission does not imply this separate member permission.

This is a test catalog repair for the already required route, not a new production handler, boundary exemption or baseline exception. Preserve the actual failed development result; run the complete affected unit file and include it in the final plan. Condense only redundant aggregate outer Task wording if needed, preserving every member snapshot and substantive evidence/gate obligation. No review round, runtime gate or acceptance is claimed.
