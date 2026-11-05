# Batch 26 specification reconciliation

Owner-delegated controller: thr_pz39tcih5r. Local backend delivery only; no production acceptance, changed ownership or expanded feature scope.

## Tasks JSON schema types

Gh-1540 originally named sinceTime as time, while its consumer gh-1602 explicitly stores a two-bound object {from, to}. The existing time property type and Tasks.time display value are scalar; treating the object as that type would contradict the consumer contract. Use the existing json property type with ordinary config {} for sinceTime in fresh seed and the registered per-tenant Tasks schema cutover. The field remains system-owned by tasks. Gh-1602 still solely owns when and which stored bounds are captured; this decision adds no date/time writer or custom property type.

The accepted 2026-10-25-task-and-event-recurrence-model ADR fixes a system-owned recurrence projection but does not select its property type/config. Use existing json with ordinary config {} for recurrence, also system-owned by tasks. Gh-1605 already specifies the future {preset, mode, rule} projection and owns its value population, series-table changes and advance behavior; none is implemented by gh-1540. Existing recurrence behavior and the accepted ADR body remain untouched. This is selection of existing schema types within the approved seed/cutover ownership, not a new lifecycle, storage writer or architectural exception.

Gh-1540 and its exact aggregate snapshot are reapproved together; gh-1602 is already consistent and stays unchanged. All production/test edits remain within the corresponding member's current Touches. Existing item property values must remain unchanged, and fresh/cutover schema parity and repeat no-op remain required. No runtime result is inferred by this metadata decision.

## Existing Events.time drift remains visible

The current Events.time seed property is system-owned without owner_process. The real drift checker correctly reports it; no Events time transform is currently registered. Gh-1598 owns later normalization and derivation of Events.time. Gh-1540 Task 6 assigns only Tasks.time, while its original all-Tasks/all-Events zero-drift sentence would require an unrelated ownership change without an executing Events writer.

Reconcile Task 8 and its matching acceptance criterion to zero drift findings for the properties gh-1540 introduces or updates. Preserve and separately assert/report the unchanged preexisting Events.time orphan; do not filter it out of the checker, register a placeholder process, change its schema/values, or implement gh-1598 early. This narrows the contradictory acceptance scope to the explicit schema Task and leaves the existing production ownership gap unresolved and visible, not passed. The source and aggregate are reapproved together. No accepted ADR or future issue is edited.
