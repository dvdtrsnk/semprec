---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# A manual speaker assignment settles the key's card, locking the card before the transcript

## Context

[[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] makes a speaker mapping a
validated `speakers` edge that only a human confirmation of a `transcript` card writes, and says
that replacing the person of a key takes two client writes (remove the edge, add the new one).
Issue #1770 adds `PUT /api/transcripts/:id/speakers/:speaker`, one transaction that assigns,
replaces or clears the person of a key. Two things were undecided:

1. The Inbox card that asks "who is this speaker" (idempotency key
   `transcript-speaker-suggestion:<transcriptId>:<speaker>`) stays open after a user maps the key by
   hand, although its question is answered. Only confirm, reject and revise changed a card until now.
2. The route writes a card and a transcript row in one transaction. The confirm of the same card
   locks the card first (`confirmProposalWithClient`) and then, in the edge validation
   `assertSpeakerEdgeWritable`, the transcript's item row. A route that took the two row locks in
   the other order would deadlock with a confirm.

[[2026-11-06-speaker-confirm-inserts-participants-without-metadata-replacement]] decides how the
confirm adds the person to the Event's participants, and
[[2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes]] decides that an undo of a
confirmed card is driven by the writes the card recorded.

## Decision

- **Lock order.** The route locks the key's card first, then the transcript's item row, the order
  of the confirm. The card is found by its idempotency key before any lock. The Event participant
  write (`createRelationIfAbsentWithClient`, insert-only, no invitation) takes no Event lock: the
  participant hook returns before any lock for such a write, so there is no Event position in the
  order.
- **A card that appears while the route waits.** `proposeSpeakerMappings` locks the transcript and
  creates the cards in its own transaction, so a card can commit while the route waits for the
  transcript lock and be invisible to the first lookup. Once the transcript is locked the route
  looks the card up again. Locking it then would reverse the order, so the route takes that lock
  with `NOWAIT`; a busy card ends the request with `409 version_conflict`, which is retryable and
  rolls back every write of the call. Waiting is not an option: it could deadlock with a confirm of
  that card.
- **The card is settled in the same transaction** by `settleSpeakerCardWithClient`, only for a
  non-null person. It locks the card and settles it only while its status is `proposed` or
  `needsClarification`; a `confirmed`, `rejected` or `invalid` card, one in the Trash and a missing
  one are left alone. The card becomes `confirmed` when its stored proposal is exactly this person
  for this key (a `relation` envelope through `speakers` whose metadata is exactly `{ speaker }`),
  and `rejected` otherwise. Its history gains an entry that a manual assignment settled it. Clearing
  a key settles nothing.
- **What a manual settle records.** A card confirmed this way gets the result a confirm stores for a
  speaker card (the transcript as primary result, the person as `resultItemId`) and no
  `addedRelations` history entry, even when the route added the person to the Event's participants:
  the edge and the participant are the user's own writes, not writes the card made.
- **This supersedes for this route only** the consequence "replacing who a key belongs to takes two
  writes" of [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]]. The generic
  relation endpoint still takes two.

## Consequences

- Any later writer that takes both a speaker card and its transcript (a revise, a clear that settles
  cards, an undo) must take the card first, then the transcript, and take a card it finds later with
  `NOWAIT`.
- A reopen driven by recorded writes finds none on a card settled manually. It must not assume that a
  `confirmed` speaker card has an `addedRelations` entry, and it does not remove the speaker edge or
  the participant the user wrote by hand. A different behaviour is a new decision.
- A client may see `409 version_conflict` on the assignment in the rare overlap above and should retry.
