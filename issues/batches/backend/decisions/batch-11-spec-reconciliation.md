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
