---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A Journal merge does not refuse an edge the survivor already holds and logs the field of each refusal

## Context

[[2026-11-10-journal-duplicate-merge-locks-the-reservation-before-both-entries]] decided how `mergeJournalDuplicates`
moves the relation edges of the merged entry to the survivor: `moveRelationEdgesWithClient` asks, for each edge,
whether the choke point would refuse it for the survivor, leaves a refused edge on the duplicate and reports it in
`refusedEdges` and in one `info` line of the `journal` logger. That record stays as it is. This one narrows two of its
statements, which the recheck of issue #1726 found to be wrong in effect:

- It says an edge the survivor cannot take is refused "for an item in the Trash", and the move asked that question
  before it asked whether the survivor already had the edge. When both entries are linked to the same item and that
  item is in the Trash, the choke point refuses the edge for the survivor because its other endpoint is not live,
  although the survivor holds exactly that edge. The merge then reported and logged an edge that was not lost and left
  the duplicate's copy behind.
- It says "the line carries no `field`, name or content". The line carried the refusal's `code`, which is always
  `validation_failed`, so it did not say why an edge was refused.

## Decision

- **An edge the survivor already holds is never refused.** For each edge of the duplicate, before the refusal check
  runs, `moveRelationEdgesWithClient` normalizes the edge as it would be written for the receiving item and reads it
  by its tuple (relation definition, the two items, the orientation). When the receiving item holds it, the move
  deletes the giving item's edge through `deleteRelationWithClient`, counts it in `moved`, and writes nothing on the
  receiving item: no refusal check, no create, no entry in `refused`. Why: `refusedEdges` is what a caller tells the
  user from, so it must name only edges that were really left behind, and an edge the survivor holds loses nothing when
  the duplicate's copy is deleted, whatever state its other item is in. Every other edge keeps the path of the earlier
  record: refusal check, delete, create if absent.
- **The log line carries the `field` of each refusal.** The line of the merge gains `field`, equal to the `field` of
  the matching `refusedEdges` entry. It is one of a fixed set of names: `callerItemId` or `targetItemId` for an endpoint
  that is in the Trash or missing, a property key (for example `area`) for a value derived from the item's project, or
  `null` for an edge a domain edge-write hook refuses, which names none. It is never an item's name or content. Why:
  `field` is what tells the refusals apart, and an operator reading the log cannot otherwise see which kind of edge a
  merge left behind. Ids, `code` and `field` are still all the line carries; the message text and the registration with
  `runAfterCommit` are unchanged.

## Consequences

- The sentence of the earlier record "an edge to a trashed item does not reach the survivor when that item is restored
  later" holds only for an edge the survivor did not already have. An edge it already held stays on it, and is live
  again with the item.
- The read of the survivor's edge takes no row lock. A concurrent transaction that deletes that edge and commits
  between the read and the delete of the duplicate's copy leaves the survivor without the edge and the duplicate
  without its copy, which is the state of that transaction's delete running after the merge. A concurrent insert of the
  edge changes nothing the move relies on. This record claims no more ordering than that.
- Because an edge the survivor holds is not created again, none of the hooks of a create runs for it, and its metadata
  stays as the survivor's own, as before.
- `moveRelationEdgesWithClient` has the same rule for any caller; today that is the merge and, through
  `moveJournalDayEdges`, the Inbox `journalDay` move.
- The shapes of `MoveRelationEdgesResult`, `RefusedRelationEdge` and `MergeJournalDuplicatesResult`, the `code` of a
  refusal and the lock order of the merge are the ones of the earlier record.
