---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A `mailThread` card proposes one task of a thread, with a name and a date only, and is confirmed as a user write

## Context

Semp never creates a task from a mail thread silently: it proposes the task in the Inbox, the user may edit the
proposal, and only the user's confirm creates the task (issue gh-2034; the tool that creates the card is issue #2035).
The Processing proposals card kinds, their producer processes, production sites and source relations are the table of
[[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]], which supersedes
[[2026-09-23-processing-proposals-card-creation-owned-per-kind]] and says that adding a new `kind`, a new producer
process or a new production site is a new decision. The `inboxPipeline` manifest records that table as its ownership
handoff. A task made from a thread is not a plain task: it needs the `Threads.tasks` edge and the thread's project and
people as inherited values, which one function writes ([[2026-11-14-a-task-made-from-a-mail-thread-inherits-its-project-and-people]]).

The alternatives were to reuse the `inbox` kind with a relation to the thread, or to let the card carry the task's
project and people. The first gives the confirm no source Threads item to hand to the task function; the second would
store values that the thread owns and that the function derives at confirm.

## Decision

- **A third `kind`, `mailThread`,** extends the table of [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]]
  without replacing it (its other rows and its rules carry over unchanged):

  | `kind`       | Producer process                                             | Production sites | Source relation |
  | ------------ | ------------------------------------------------------------ | ---------------- | --------------- |
  | `mailThread` | not decided here: issue #2035 names the process and its site | none yet         | `sourceThread`  |

  Until that issue decides, no process produces `mailThread` cards, and a card of this kind created by any other
  writer is an ownership violation as for the other kinds.

- **`sourceThread`** is a one-directional, system-owned `many_to_many` relation from Processing proposals to Threads
  (owner process: the Processing proposals module). A card has one edge; it is the card's only link to the thread, and
  the card records nothing else of it. A card with no edge is a `ValidationError` on `sourceThread` at revise and at
  confirm. The edge is removed when the Threads item is purged (the Trash retention purge deletes every edge of the item),
  so a card whose thread was purged is a card without an edge and answers that validation error; a Threads item that is
  only in the Trash still has its edge, and confirm answers 409 `conflict` on it. A merge of two threads moves the
  edge to the surviving thread ([[2026-11-05-mail-thread-item-merges-transfer-existing-relations]]).
- **The envelope is restricted.** It is a `database` envelope for the Tasks database whose `properties` are a
  non-empty `name` of at most 500 characters and an optional calendar `date`, and nothing else: no `relations`
  (not even an empty object), no `operations`, no other target or entity kind. The task's project and people are not
  on the card; they come from the thread at confirm, and the user changes them on the task afterwards, which ends the
  inheritance. The same rules apply at revise and at confirm.
- **Confirm is a user write through `createThreadTask`.** `confirmProposalWithClient` does not call
  `createItemWithClient` for this kind. It locks the card's Threads item, answers 409 `conflict` (`field: sourceThread`)
  when that item is in the Trash or the lock finds no row (the item was purged between the read of the edge and the
  lock), and otherwise calls `createThreadTask` in the confirm's transaction with the writer `{ writerKind: 'user' }`,
  so the task, its `Threads.tasks` edge and the inherited values commit with the card's `confirmed` status or not at
  all. The card has no Inbox item and no transcript to take item origins or an origin note from, so confirm writes
  none. A credential on the confirm is refused.

## Consequences

- The handoff comment of the `inboxPipeline` manifest lists the `mailThread` row and this ADR.
- The producer of #2035 creates the card and its `sourceThread` edge in one transaction; a card without the edge cannot
  be revised or confirmed.
- A purged source thread leaves a card that the user can only reject. It answers the `validation_failed` error on `sourceThread`, not 409,
  because the purge leaves nothing that tells a purged thread from a card made without an edge.
- Existing tenants get the `mailThread` option of `kind` and the `sourceThread` relation from the tenant cutover
  `runThreadTaskProposalCutoverMigration`; fresh installs get them from the seed.
