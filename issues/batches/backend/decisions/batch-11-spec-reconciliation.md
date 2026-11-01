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

## 11. Relation admission, lock-wait scope and rollback-only owner

The parent independently checked both source/link and definition/link deadlock logs, and the populated-rollup queue/link negative at clean test-only 68af2630 (production bytes equal 1c75b6eb). The latter shows real PostgreSQL transaction ShareLock waits in public graphile_worker.add_job versus value_links UPDATE. The focused relation review and two read-only addenda support a bounded conditional protocol; none is whole-batch acceptance.

Accept the new relation-admission ADR, its fixed 409 value_link_busy and 1ms transaction-local per-lock-wait policy for protected valueLinks user-owned relation mutations. Preserve early 403 prediction and original endpoint/metadata validation, admit exact domain source/transcript, definition and existing edge without blocking, then acquire the authoritative link NOWAIT and protect the remaining body through rollup enqueue. Ordinary writers, system-owned properties, item handoff and proposed-nil validation retain their contracts. Prediction-only validation takes no handoff lease. Busy may precede later cardinality/missing-edge errors; unknown errors, 40P01 and 57014 remain unchanged.

An invocation-owned private db/pool rollback-only marker is required: false try-advisory must not be caught and committed, and a savepoint must not erase a busy refusal. Protected mutations require an active sanctioned withTransaction client. Caught errors followed by callback success rethrow the first recorded error before COMMIT; an unrelated escaping callback error remains primary. Clear ownership/marker state on every exit. Mark all protected-body failures after timeout installation so caught errors cannot leak the local setting. Restore the exact prior effective setting only on success; on failure do not mask it with SQL restoration in an aborted transaction. Audited owner propagation, full rollback of state/jobs/events, setup/cleanup failures, first-error identity and next-borrower cleanliness require permanent proof.

Authorize only gh-1516's added exact production/test paths for this contract. No private queue-table lock, new global mutex, automatic retry, migration or future link producer is authorized. The measured three cycles must be replaced with healthy permanent assertions under actual runtime tenant roles and exact operation PIDs. Pre-held proposal/edge/source cases, all registered hooks, A/B and replay/update/delete, busy/permission precedence and effective-setting restoration remain mandatory. Any confirmed residual in-scope cycle must return for adjudication; neither per-call lock timeout nor the marker proves global transaction safety or a wall-clock deadline.

To remain below the aggregate model-body limit, its duplicate top-level Touches inventory is replaced by an exact union reference to the full embedded member Touches. All seven source snapshots, original path scopes, Tasks/decisions/AC and immutable handovers are preserved. This refreeze is specification/architecture only, not implementation, gate success or completion.

## 12. Complete independent R2 review: bounded corrections and fixtures

The parent checked the complete NOT CLEAR report at frozen 866e3648 (SHA256 2dc5a67c2e88d745f3caec73adf98b20be97b7d42ac1da61256e92a48c692ba5). One high and six medium findings need correction and renewed review; the reviewer ran no suites. No previous development result or candidate exception is acceptance.

H1 belongs to gh-1610's existing-ID refusal and validation-before-mutation: check actual Yjs block-map membership for requested and generated IDs, including existing malformed truthy/falsy entries. Such deliberately constructed remote-CRDT scalar/map fixtures are synthetic boundary controls, not historical database records or claims of observed corruption. Use actual Yjs state and full encoded-state no-change assertions with typed duplicate refusal, including bulk partial-mutation negatives. This does not authorize production repair of historical data or a new storage schema.

M1/M4/M5/M6 remain within current named source/test scopes: preserve actual production hook registrations, exercise real Tasks transformed contention, and complete the declared state/link/event/job/setting/owner/error/Tasks controls. Removing unrelated production hooks is not valid composition evidence. Require complete affected-suite execution after fixture repair and honest development-versus-final-SHA attribution.

For M2 authorize only the existing proposalActions.test.ts path under gh-1422 for a discriminating actual registered-transform preparation/confirm composition. A declared before key must genuinely be absent from the later prepared patch; stale confirm must still refuse and leave card and target unchanged. Keep the explicit-null Tasks contract and its existing useful assertions. A local synthetic registered test transform is permitted; restore the registry deterministically and do not add a production transform, change proposal execution/precondition policy, or implement deferred proposal features.

For M3 extend gh-1516's already named relationsStore.ts scope only to typed error classification in its existing create catch: actual pg.DatabaseError SC001 keeps the current cardinality error; an arbitrary object or other error with that field propagates by exact identity. Exercise the actual protected create path with both a real cardinality-trigger control and a non-driver spoof. No new SQLSTATE, constraint, schema, retry, error text policy or unrelated mapper change is authorized. This implements the existing relation ADR's unknown-error promise; no architecture or accepted ADR body changes are needed.

Refresh both source approvals, complete aggregate snapshots and dispatch hashes together. All seven original handovers remain immutable. Fixes require fresh independent delta review carrying the full clause and grouped boundary audit before final exact-candidate targets and full verify.
