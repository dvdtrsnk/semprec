---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Value-link item updates lock their item before checking handoff

## Context

[[2026-11-01-value-link-handoff-covers-transformed-user-properties]] requires an existing-item `valueLinks` update to authorize its caller keys and the user-owned keys emitted by its final transform. [[2026-10-29-item-pre-write-transforms-per-module-registry]] supplies the locked snapshot for registered transforms and preserves ordinary update behavior.

The previous item handoff took a link row `FOR SHARE` before the item lock. A changed user write took the item lock before updating that link to broken. Two controlled production-call schedules, using tenant-scoped runtime connections, produced PostgreSQL `40P01`: each transaction held the row the other needed. The system operation was the victim in one order and the user operation in the other. These measurements establish this isolated item/link cycle, not a relation or transaction-wide safety result.

A focused independent design review supports the item-first repair below. It also identifies separate static relation/source/advisory/proposal hazards for further audit. This decision does not select a global relation protocol or infer implicit endpoint locks from foreign keys: value-link item IDs and relation endpoint item IDs have no item foreign key.

## Decision

For an existing-item `updateItemWithClient` call with `systemOwnerProcess: "valueLinks"`:

1. Preserve the normal database, property, caller-ownership and incoming-value checks. Load the target through its database and tenant scope, and take the existing `itemsStore.lockItemById` item row lock before any active-link handoff lock. This is the update's existing inevitable item lock moved earlier, not a new lock on ordinary writers.
2. A missing, deleted or tenant-invisible target is `404` before link lookup, after those normal input/database guards. A visible live target whose required active link is missing, broken or tenant-invisible is `403 owner_violation`. This deliberately changes missing-item versus missing-link error precedence; another tenant's item must remain indistinguishable from a random missing item.
3. Reuse the locked item snapshot for any registered pre-write transform. Preserve added-key ownership checks, final color/title validation, version validation and the normal persistence/hook path. Legitimate transform-derived system keys are not subjected to caller ownership again.
4. Build the union of all caller keys and all user-owned keys in the final transformed patch. Deduplicate and sort keys by deterministic, locale-independent string order. Check each required active link using the existing handoff lock before writing item values or running their post-write hooks. Null and equal values still require the declared property handoff.
5. Item and link locks last until the caller's transaction commits or rolls back. Refusal rolls back transactional work, including any transform allocation; after-commit events must not escape a refused transaction. Read-only preparation remains read-only and does not perform deferred allocation.

Ordinary non-`valueLinks` writers without transforms retain their existing lock acquisition in the store update. Ordinary transformed writers retain their current transform lock. This decision does not add a global mutex, change transaction isolation, add automatic deadlock/serialization retries, create missing link rows, or change create behavior. The bounded successful serialization claim is for the measured isolated same-item calls under the existing `READ COMMITTED` transaction helper; it is not a success guarantee under other isolation levels or unrelated pre-held locks.

## Consequences and verification limits

- With a changed user write first, that write commits the value and broken link; the waiting system write then refuses without a write or event. With the system write first, its active handoff permits the write while links remain on; the subsequent changed user write commits and breaks the link. Both schedules require exact operation PIDs, observed blocking and complete settlement in permanent runtime-role tests.
- Equal-value user writes retain their ordinary item-update effects. Only their link state is unchanged; do not call them no-write operations. Test rollback release, stale version, multiple keys, unrelated item/tenant progress, transformed output and missing/deleted/foreign error precedence separately.
- Sorted keys are deterministic acquisition order, not proof of global deadlock freedom. The caller may already hold other item, source, blob, edge or advisory locks. This helper cannot undo an earlier opposite-order acquisition.
- A future link-producing caller such as gh-1593 must arrange the target item lock before inserting an active link and then writing its value. It needs a reviewed composition covering uniqueness, source references and multiple items. No new insertion implementation or speculative public locking API is introduced here; current link insertion remains an exported fixture/future-consumer seam.
- Relation handoff, Inbox source hooks, A/B link breaking, edge/cardinality advisory locks and pre-held proposal locks remain unchanged. Their plausible cycles stay open audit questions; this item repair does not declare them repaired or waive a subsequently confirmed in-scope defect. A relation reorder needs supported reproduction and its own explicit protocol, including validation-only, proposed-nil and deleted/missing behavior.
- Permission negatives for generated user-owned fields, all-active success without a derived-system-time link, refusal rollback/no-events and all existing ownership/value checks remain required. The old diagnostic intentionally asserting deadlock is retained as historical negative evidence and replaced by healthy permanent scenarios for the new implementation. This ADR is not batch acceptance.
