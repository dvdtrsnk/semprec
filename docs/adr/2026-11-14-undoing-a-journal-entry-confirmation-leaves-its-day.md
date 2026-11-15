---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Undoing a journal entry confirmation removes its blocks and recorded edge and leaves its day

## Context

[[2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes]] says the undo of a confirmed card reverses
what the confirm recorded, trashing the items the confirm created. [[2026-11-14-the-undo-of-a-confirmation-reverses-only-the-edges-it-recorded]]
says it deletes only the edges the confirm recorded in the history entry of the confirmation.

The confirm of a `journalEntry` card (issue gh-1981) writes into an existing kind of item, a Journal day, that is created
lazily: `ensureJournalPeriodDoc` returns the day when it exists and creates it and its page when it does not. The confirm
inserts the entry's blocks at the end of the day's page, with ids derived from the proposal id, and writes the day's
`project` or `area` edge. The result it stores for the card lists those block ids and the day's `updatedAt`, and records
no fact about whether the day existed before.

## Decision

- **The undo treats a journal entry as a page insert into its day.** It removes the blocks the confirm inserted
  (`results.blockIds`, the `pageContent` reversal), under the same precondition: the day must still be live with the stored `updatedAt`, or
  the undo is the 409 `version_conflict` that names the day.
- **The day's edge is written with `writeRecordedEdge`** and so is in `writtenRelations`. The undo deletes it when the
  confirm inserted it and leaves it when the day already had it, as the 2026-11-14 edge ADR requires of every confirm step
  that writes an edge between existing items.
- **The day stays.** The undo does not trash a day, whether or not the confirm created it, because the result does not
  record who created it and trashing a day the user already had would remove its other entries and edges. A day the
  confirm created is left with an empty page, which is what a lazily created day is before its first entry.

## Alternatives rejected

- **Record that the confirm created the day and trash it on undo.** It adds a field to every stored result for a day
  that any later visit or entry creates again, and the day may by then hold what the confirm did not write.
- **Refuse to reopen a confirmed journal entry card.** A card that cannot be returned to the stack is the gap the undo
  exists to close; the page insert reversal already exists and fits.

## Consequences

- A re-confirmed card inserts the same block ids again, which the undo freed by removing them.
- A day created by a confirmed and then undone entry remains in the Journal as an empty day.
