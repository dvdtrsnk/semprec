# Batch 11 specification reconciliation

## 1. Existing append-only pre-write-transform ADR

The owner-delegated parent controller accepts the existing accepted 2026-10-29 item-pre-write-transform ADR as the documentation required by gh-1422 Task 6. Its Context explicitly amends the Tasks exception of the accepted 2026-09-30 hook-registry ADR without editing that historical body. Its supersedes metadata and the 2026-09-19 ADR's status/superseded-by frontmatter already represent the requested replacement. Preserve all three existing files; no new architecture or duplicate ADR is required by this documentation reconciliation.

This resolves the literal Task/Touches request to edit an accepted historical paragraph in favor of the append-only ADR convention. The source Task 6 and source/aggregate Touches now state this exact reconciliation, and their approved snapshots and manifest hashes are refreshed together. Other Tasks and all acceptance criteria remain unchanged. Existing ADR prose or a recovered handover is not proof of implementation compliance: ownership, replay, locks, transformed-patch propagation, Tasks behavior and no-domain requirements must still be audited and evidenced under the current combined batch. Any further conflict needs a separate scoped decision.

The batch remains incomplete. No source implementation, runtime test, independent review, final gate or completion is established by this decision. Seven original member handovers remain immutable.

## 2. Transform-added system-key ownership

Retain the explicit existing null-or-owning-module ownerProcess contract of the accepted registry ADR. Transforms run only for their database's ownerModuleId. Seeded Tasks/Events derived time keys have null ownerProcess; this decision does not assign ownership to another process, add a seed migration or permit caller writes to derived fields. Keep mismatch refusal and unknown/relation/rollup guards, with positive and negative production tests.

## 3. Tasks legacy compatibility and combined tests

Retain the existing accepted Tasks validation ADR's per-key update scope: name when named, complete resulting schedule when any date/time input is named, unrelated legacy-invalid values unchanged. Create still runs schedule validation and validates a supplied name, with the existing generic missing-title policy. No repair migration or newly accepted invalid schedule is authorized. When schedule validation runs and date is null, the specified three time fields must be stored explicitly as null; absent keys are not proof of this requirement.

The old gh-1422 unchanged-test instruction cannot restore inputs explicitly rejected by included gh-1536. Preserve valid derivation assertions, use valid dates and H:MM/HH:MM fixtures, and assert refusal plus unchanged state for newly invalid end-only or retained-end/cleared-start writes. Retain the pure deriveTaskTime unit suite unchanged. Scope the existing item-handler HTTP suite for real status/field/no-write and replay evidence.

## 4. Named localized and linked-value boundaries

Authorize only the added existing permanent test paths in gh-1413 and gh-1516 Touches. Actual Czech/English schema/property HTTP responses and saved status-filter execution over real Health-record items must support the label criteria; SQL string output alone is insufficient. Use actual REST and minted-run-credential MCP writes/reads for inheritedBroken/brokenBy, with correct grants and runtime tenant isolation. No production transport behavior, client localization or dependency change is authorized by this test scope.

## 5. Markdown fixture classes and plain text

Canonical serialization intentionally differs from noncanonical accepted aliases. All representable vectors require parse plus canonical serialization and round-trip assertions. The synthetic empty-document serialization and parser refusals remain explicit separate cases, without fabricating physical blocks. stripMarkdown reduces page-link labels to visible plain text like other links; parseMarkdown continues discarding their titles in page-model inputs. Keep strict fixture-boundary validation and all original required sample cases.

## 6. Empty block-operation inputs

Retain the recovered explicit empty blocks/ids no-write no-op; existing input validation still applies. It neither tidies order nor materializes a synthetic empty document. Non-empty operations still enforce all stated invariants within one caller-origin Yjs transaction. Prove both classes separately. This is a bounded API clarification, not a new storage/transaction mechanism or permission for mutation before validation.

## Remaining audit work

The suspected value-link/item opposite lock order remains a static finding awaiting bounded production-path reproduction and a separate locking/ADR decision if confirmed. No new lock contract is authorized here. Invalid runtime block-type rejection before Yjs mutation and the explicit-null Tasks fix implement current scoped validation requirements; they require discriminating permanent tests and independent review. Development results, setup failures and host SysV capacity do not establish batch acceptance.

## 7. Value-link handoff includes transformed user-owned keys

For an existing-item update under systemOwnerProcess valueLinks, permission must cover both caller keys and every user-owned key emitted by the final pre-write transform, including explicit null and unchanged values. Active handoff for date does not authorize clearing timeFrom/timeTo. The derived system time field keeps the module-transform ownership rule and needs no value-link row when added by that transform. The new append-only handoff ADR narrows the earlier registry ADR's caller-only consequence for this process only; create, other writers and relation-side authorization are unchanged.

Require real Tasks production composition negatives for missing/broken generated-key links and unchanged-null output, complete rollback/no-event assertions, and an all-active positive leaving links on without a derived system-time link. These assertions remain NOT RUN until database execution succeeds. This decision chooses permission scope, not a lock protocol; production handoff changes remain held pending the separate lock-order reproduction/design. No concurrency, global deadlock or acceptance result is inferred.

## 8. Tasks decoupling is not an unrelated domain refactor

Replace gh-1422 Task 6's overly broad no-domain sentence with its actual registry/Tasks obligation: no Tasks derivation or Tasks import in itemWrites, and a module-neutral transform registry. The accepted registry ADR explicitly preserves the named Transcripts title exemption. Current mail observation convergence and its public item-lock handoff are separate existing ownership/lock contracts, not inline Tasks derivation. Preserve both without relocation, symbol-only renaming, new hooks or changed behavior. This narrow scope reconciliation grants no general exemption for future domain branches or imports. The existing no-Tasks-import AC remains. No historical ADR body changes or new architecture are required.

## 9. Final transformed values retain existing admission guards

Authorize only parity of the existing color and applicable title guards on the final effective create/update payload and side-effect-free prepared user patch. Incoming checks stay in force; preparation remains read-only; generic title writer/module exemptions and patch-only/legacy behavior remain unchanged. Task-owned stricter checks also remain. A trusted registered transform must not bypass these existing accepted value rules by adding or replacing a value after the incoming guard. This is not a new general property schema, validator taxonomy, migration, domain exemption or permission to expand unrelated checks.

Use the already scoped pre-write-transform tests for invalid added/replaced color and applicable blank-title outputs, valid/null controls under current policy, create/update no-write/no-event rollback and read-only preparation no-mutation assertions. Current static findings are not claims that a registered production transform emits those invalid outputs or that a live exploit occurred; database execution and independent review are still required. The pending transformed-key handoff/lock implementation and IPC approval remain separate.

## 10. Bounded item-first value-link update order

The parent verified the real two-order item deadlock diagnostic (aab70c3b, log SHA256 b0d6cc38084587bb8dc3a9840634682af1110d500e00b844801cf6d93ca64bd4) and the three old-guard authorization negatives. Focused independent design review at source-equivalent036e6f78 supports a limited item-first repair and explicitly does not establish relation-wide or transaction-wide safety. The parent accepts that bounded design in the new item-lock ADR: preserve normal input/database guards, lock the scoped live item before any valueLinks handoff lock, reuse its snapshot for transforms, then check sorted unique caller plus final user-owned keys before the value write. Keep ordinary non-valueLinks/no-transform update locking unchanged.

Missing/deleted/foreign item now yields 404 before link lookup after normal input/database guards; a visible live item's absent/broken/tenant-invisible required handoff yields 403. This error precedence change is explicit and needs indistinguishability/no-effects tests. Preserve version validation, final color/title and transform-system ownership checks, rollback and read-only/deferred preparation. No new global mutex, isolation level, retry loop or relation lock protocol is authorized.

Required runtime tests cover both item acquisition orders, each winner's value/link/events, transform-backed and plain updates, all generated-user-key permission branches, rollback release, stale version, equal-value normal effects, multiple keys and unrelated item/tenant progress. The diagnostic expects deadlock and must be replaced by healthy permanent assertions; its historical log remains a deliberate negative. Relation/Inbox/source/advisory/proposal risks remain OPEN AUDIT hypotheses, not declared repaired or waived. Triage feasible supported schedules during full review and escalate any confirmed in-scope defect before acceptance. Future gh-1593 must acquire the target item before creating an active link and writing the value; no insertion or future production consumer is implemented here.

Aggregate top-level duplicate mentions of index.ts/itemWrites.ts were collapsed to one entry each restricted to all member-declared scopes. No member snapshot, Task, Touches or AC was dropped; the combined path union is preserved within the model body limit. All eight current approvals and original seven handovers remain required.
