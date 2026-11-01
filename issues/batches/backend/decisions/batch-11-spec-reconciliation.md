# Batch 11 specification reconciliation

## 1. Existing append-only pre-write-transform ADR

The owner-delegated parent controller accepts the existing accepted 2026-10-29 item-pre-write-transform ADR as the documentation required by gh-1422 Task 6. Its Context explicitly amends the Tasks exception of the accepted 2026-09-30 hook-registry ADR without editing that historical body. Its supersedes metadata and the 2026-09-19 ADR's status/superseded-by frontmatter already represent the requested replacement. Preserve all three existing files; no new architecture or duplicate ADR is required by this documentation reconciliation.

This resolves the literal Task/Touches request to edit an accepted historical paragraph in favor of the append-only ADR convention. The source Task 6 and source/aggregate Touches now state this exact reconciliation, and their approved snapshots and manifest hashes are refreshed together. Other Tasks and all acceptance criteria remain unchanged. Existing ADR prose or a recovered handover is not proof of implementation compliance: ownership, replay, locks, transformed-patch propagation, Tasks behavior and no-domain requirements must still be audited and evidenced under the current combined batch. Any further conflict needs a separate scoped decision.

The batch remains incomplete. No source implementation, runtime test, independent review, final gate or completion is established by this decision. Seven original member handovers remain immutable.
