---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The approval check of a relation delete locks the edge's endpoint rows before it reserves its value links

## Context

[[2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links]] makes the item row come before the value link rows of that item: the propagation job and the engine's edge hook lock the rule's target item and then its link, and a user or agent edge write on a link rule's via relation now does the same. It lists three paths of the tree that take link rows against that order and end with `40P01`, and repairs none of them. The third is the replay of an approved agent `relation.delete`, `relation.put` or `relation.set`: `replayApprovedGenericOperation` runs the destructive projection check of [[2026-11-12-an-agent-write-that-ends-a-value-link-requires-approval]] and the write in one transaction, and the check share-locks the `on` links of the edge's sides before the write's own lock on the item row. The check and the replay's exactly-once execution are described in [[2026-09-18-exactly-once-execution-of-approved-destructive-operations]].

Reproducing that path with the production calls of the replay (pools of the runtime role `semprec_data`, one participant per transaction, a third transaction holding the transcript's row, the propagation of the Event's project started first) shows that only `relation.delete` ends with `40P01`. The projection of `relation.delete` reserves the links of the edge (`reserveEdgeLinks`) and locks no item row. The write that follows runs the before-link-break hook of the ADR above, which locks the rule's target item row, the transcript for `Transcripts.project`, with a blocking wait. The replay therefore holds the `project` link and waits for the row, the propagation gets the row and wants the link `FOR UPDATE`, and PostgreSQL ends one of the two. The projections of `relation.put` and `relation.set` lock the caller and the target (and for a set the targets of the old edges) with `lockItemByIdNowait` before they reserve the links, so in the same schedule they hold the row before the links and a held row is an `ApprovalResourceBusyError`. They are not changed.

## Decision

The projection of `relation.delete` (`computeDestructiveResourceProjection` in `chokePoint/destructiveProjection.ts`) locks the two endpoint item rows of the edge with `lockItemByIdNowait`, the caller's row in the database of the relation property and the target's row in the target database, sorted by database id and then item id as the projection of `relation.put` and `relation.set` sorts them. It does this after it has read the edge and before it reserves the edge's value links. A row that does not exist is skipped, because an edge to a purged item can still exist. A `55P03` (the row is held) becomes `ApprovalResourceBusyError` after the transaction is marked rollback-only, as every other approval reservation does; any other error propagates. The snapshot, `currentResource` and `valueLinks` of the result are unchanged, because row locks are not part of the projection.

The order of the locks of the approval check, for the three relation kinds, is:

- `relation.put` and `relation.set`: the relation definition advisory lock, the property, definition and database rows (shared), then the endpoint item rows (for a set also the targets of its old edges), then the edges of the caller, then the `on` links. This is the order of the code before this ADR.
- `relation.delete`: the endpoint item rows, then the `on` links. The endpoint rows are the new step.
- Then the write's own lock on the item row: the before-link-break hook of the ADR above locks the rule's target item, which is one of the two endpoints of the written edge, so the transaction already holds it and the lock does not wait.

The check waits for none of these locks: every one of them is taken without waiting, and a held row is a busy refusal.

## Consequences

- A `relation.delete` request or replay is refused as busy while another transaction holds the item row of either endpoint of its edge. This also applies to a relation that is no link rule's via relation; `relation.put` and `relation.set` already behave so. The request-time projection of an agent's `relation.delete` answers `approval_resource_busy` while an endpoint row is held, as it does for put and set.
- The queue retries the replay when its reservation is busy, as it does for every other busy reservation; the replay of the schedule in the Context ends busy and the propagation commits.
- The hash of the snapshot does not change, and neither does what a request shows. A request created before this change replays against the same snapshot.
- The projections of `relation.put`, `relation.set`, `item.patch`, `link.unlink` and the other kinds are not changed.
- Measured, in `backend/packages/data/src/__tests__/relationDeleteApprovalLockOrder.test.ts` with the replay's own steps in one transaction (the projection check, then `deleteRelationWithClient`, `createRelationWithClient` or `setRelationWithClient` as an agent without a run): with the propagation waiting for the transcript row first, `relation.delete` ended with `40P01` for the replay before the lock and ends busy with the propagation committed after it; `relation.put` and `relation.set` end busy with the propagation committed both before and after. With nothing held the replay of `relation.delete` commits and ends the edge and its link. `destructiveResourceProjection.test.ts` shows that a held row of either endpoint is refused at once and marks the transaction rollback-only, that the snapshot hash of an unheld edge is the one the projection had, and that an edge whose other endpoint row no longer exists still projects.
- Not measured: the replay through `replayApprovedGenericOperation` itself with an approval request row, and an agent with grants. The two paths that the ADR above lists first and second (the trash of an Event against the release of a removed `event` edge, and the trash of an Event that hosts a task which is also sourced from it) are not repaired here.
