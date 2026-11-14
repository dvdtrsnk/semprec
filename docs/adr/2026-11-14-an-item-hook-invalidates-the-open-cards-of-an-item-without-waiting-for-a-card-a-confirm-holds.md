---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# An item hook invalidates the open cards of an item without waiting for a card that another transaction holds

## Context

An open Processing proposals card that refers to an existing item (the project a task would be created in, a person to
link, the page an entry would be appended to) is unusable once that item is archived or deleted. gh-1916 makes the card
`invalid` in the transaction that archives or deletes the item, and returns it to `proposed` when the item comes back.
The item update, delete and restore hooks of [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] and
[[2026-11-07-item-delete-and-restore-domain-hooks]] are the place for that: they run inside the write's transaction, so
the card is never `proposed` for a target that is already gone, and a rollback of the write takes the card change with
it.

The hook therefore takes row locks in an order that no existing writer of a card uses. The item's own row is already
locked by the transaction (the update locked it, and a trash or restore cascade locks every row it changes), and the
hook then needs the cards. Confirm, reject, revise and the values edit take the card first (`lockLiveProposal`), and
confirm then reads and writes the items the card refers to. A hook that waited for a card that a confirm holds, while
that confirm needs an item the hook's transaction has changed, would be one half of a deadlock cycle.

## Decision

The hooks of `inbox/proposalReferenceInvalidation.ts` find the cards through the `referencedItemIds` property that
every writer of a card's `proposal` stores (`referencedItemIdsOf`, `inbox/proposalReferences.ts`) and lock them with
`SELECT ... FOR UPDATE SKIP LOCKED`: a card that another transaction holds the lock of is skipped, never waited for.
The cards are found with one JSON containment on `properties` (`items_props_gin`): status `proposed` and the item id
among the `referencedItemIds` to invalidate, status `invalid`, the item id among them and an `invalidReason` of the
same code and item to restore. Only `proposed` cards are invalidated, and only a card whose stored envelope passes
`assertValidProposalEnvelope` again is returned to `proposed`. The hooks run for the items of any database; the update
hook reacts only to a Projects write that names `status`, and only `archived` is a reason (a `done` project stays a
valid target).

A skipped card keeps the status it had. For a card that a confirm holds this is correct: the confirm validates its
targets itself before it writes anything, and refuses an archived or deleted one. For a card held by another writer
(a values edit, a revise, a reject) it means this write does not invalidate the card, and an `invalid` card that is
held while its item comes back is not returned to `proposed`; it stays as it was until its next write, and a confirm
of a `proposed` card whose target is gone is refused by that validation. The hooks never wait for such a card and
never fail the write they run in because of it.

A card that the hook's own transaction is confirming is not skipped by `SKIP LOCKED` (a row lock the transaction holds
itself is never skipped), yet it is as much a card "being confirmed" as one held by another transaction: a multi-step
proposal whose update step archives the project the card refers to runs the Projects update hook inside the confirm.
`confirmProposalWithClient` therefore marks the card (`runWhileConfirmingCard`, `inbox/proposalReferences.ts`, a mark
per connection that lasts until the confirm settles) and `lockCardsContaining` skips a marked card, so the confirm
settles its own card and no `invalid` write, history entry or `updated` event precedes the `confirmed` one.

The restore hooks treat a `ForbiddenError` of the envelope revalidation (a database the card's envelope writes to was
archived, or a relation is not writable) like a `ValidationError`: the card stays `invalid`. A card of someone else's
envelope never fails the restore or un-archive of the item the user touched.

## Consequences

- The hooks never wait for a card, so they add no wait, and no lock cycle, between the transaction that changes an item and
  a confirm of a card that refers to it.
- A card written before `referencedItemIds` existed has no ids and is not found by the hooks until a writer next stores
  its `proposal`. This decision adds no backfill.
- Every new writer of a card's `proposal` stores `referencedItemIds` with `referencedItemIdsOf`; a unit test reads the
  source files and fails for an inline `allowedSystemKeys` list that names `proposal` without it.
- Each row the trash cascade deletes or restores costs the hook one lookup of the Processing proposals database and one
  indexed card query, also when no card refers to the row.
