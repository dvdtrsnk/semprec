---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# The undo of a confirmation reverses only the edges it recorded

## Context

[[2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes]] says the undo of a confirmed card is driven
by what the confirm recorded, deletes the edges "created between items that already existed", restores the previous
values of patched items and soft-deletes every created item. It also says the confirm records what the undo needs. This
decision narrows that ADR for the edges and for two writes the undo cannot take back (issue #1943). It does not edit it.

The relation write the confirm uses (`createRelationWithClient`) is an upsert: written over an edge that already exists
it inserts nothing and replaces the metadata. A confirm that writes a link step's edge, or a transcript card's `event` or
`speakers` edge, therefore cannot tell from the write alone whether the edge is its own. An undo that re-derives the edges
from the card's envelope deletes an edge the user had made before the confirmation, with no Trash to bring it back.

## Decision

- **The confirm records every edge it writes between items that already existed**, in the history entry of the
  confirmation. `writtenRelations` holds, per edge, the metadata the edge had after the write and `previousMetadata`:
  `null` when the confirmation inserted the edge, the metadata the edge already had when the write replaced it.
  `removedRelations` holds the edges an update step deleted, with their metadata. The write is
  `writeRecordedEdge`, which inserts with `createRelationIfAbsentWithClient` and, only when the edge was there, replaces
  its metadata with `createRelationWithClient`, so the outcome is decided by the statement that wrote the edge and not by a
  read before it. Edges from an item the confirmation created are not recorded: they stay with the item in the Trash.
  The Event participant edges of a speaker card keep their own record, `addedRelations`
  ([[2026-11-06-speaker-confirm-inserts-participants-without-metadata-replacement]]).
- **The undo reverses only recorded edges.** An inserted edge is deleted; a replaced edge gets its previous metadata
  back; a removed edge is created again with its metadata, unless an edge between the two items exists by then. An edge
  that is gone, or whose metadata is no longer what the confirmation wrote, is left as the user has it.
- **A manual speaker assignment records nothing**, so the undo of a card that `settleSpeakerCardWithClient` closed reverses
  no edge. That is what
  [[2026-11-12-a-manual-speaker-assignment-settles-the-key-card-in-the-confirm-lock-order]] needs, and the undo no longer
  reads the wording of a history message to know it.
- **The Events item a `relation` confirm materialized from a synthetic occurrence stays.** The item is a copy of the series'
  own occurrence, and `materializeEventOccurrence` treats an occurrence item in the Trash as a cancelled occurrence that is
  never created again. Trashing it would cancel an occurrence nobody cancelled, and a second confirm of the reopened card
  would be refused. The transcript's edge to it is deleted.
- **The edge to a trashed Event that a transcript card's confirm released stays deleted.** The confirm deletes it so the
  pairing write meets no cardinality violation. A relation endpoint must be live to create an edge, so the undo cannot
  create it again; restoring that Event from the Trash no longer links the transcript.

## Alternatives rejected

- **Keep deriving the edges from the envelope.** It deletes the user's own edge, which no later step can restore.
- **Read the edge before the write to decide whether the confirmation inserted it.** The read is not the write: another
  transaction can insert the edge between the two.
- **Trash the materialized occurrence item.** It turns the occurrence into a cancelled one.

## Consequences

- A card confirmed before the confirm recorded its edges has no `writtenRelations` or `removedRelations`, so the undo
  leaves its link-step, update-step and transcript edges in place. That is the side that loses no user data.
- A new confirm step that writes an edge between existing items must write it with `writeRecordedEdge` (or
  `deleteRecordedEdge`) or its edge is not reversed.
- An update step whose removed edge points to an item that was trashed since cannot recreate that edge, and the undo is
  refused with the validation error of the relation write.
