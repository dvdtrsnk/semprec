---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A rejected proposal reopens to the stack without being recomputed

## Context

A rejected Processing proposal is locked like a confirmed one: `LOCKED_PROPOSAL_STATUSES`
(`backend/packages/data/src/inbox/inboxTypesStore.ts`) holds `confirmed` and `rejected`, revise refuses a locked card,
the Inbox tick skips it, and reject refuses a `confirmed` one. The user can discard a card by mistake and then has no
way back, while the Inbox needs an undo of its last decision.
[[2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes]] narrows the rule that a locked card never
changes again for `confirmed` cards and leaves the `rejected` ones to this decision (issue #1937). A reject writes no
destination, so reopening it has nothing to reverse: the card only has to return to the stack.

## Decision

- **One exit from `rejected`.** `reopenProposalWithClient` (`POST /api/proposals/:id/reopen`) is the only writer that
  sets a `rejected` card back to a stack status. `LOCKED_PROPOSAL_STATUSES` keeps both members, so the tick, revise and
  every other guard that reads it keep treating a `rejected` card as locked.
- **Nothing is recomputed.** The state a card had before it was discarded is not recorded (apart from the `invalidReason` a reject leaves in
  place, below), so the reopen does not guess it. The card keeps its stored `proposal`, `aiProposal`, `userOverrides`, `userEditedKeys` and earlier history. The
  stored `proposal` is validated by the check the tick applies to a stored envelope
  (`storedEnvelopeStillValid`, with a refused write counted as not valid), and the card becomes `proposed` when it
  passes and `invalid` when it does not. Its history gains one entry of kind `reopened`, and the Journal inbox recompute
  is enqueued. The `invalidReason` the card still holds is cleared, except a `sourceDeleted` one whose Inbox item is
  still deleted: a reject writes the status and the history only, so a card that was final-invalid (issue #1482) when it
  was discarded still holds that reason, the envelope check cannot see the source, and the card is reopened as `invalid`
  with its reason, the state it had. A `sourceDeleted` reason whose source is live again is cleared like any other.
- **State, then version.** A `proposed` card is answered unchanged, whatever `ifVersion` says, so a repeated reopen
  succeeds and writes nothing. Any status other than `rejected` is refused with 400 `validation_failed` on `status`
  (the `confirmed` card is the case of the undo ADR above). Only then is an `ifVersion` that is not the card's
  `updatedAt` answered 409 `version_conflict`. This is the order of confirm and reject.
- **No time limit.** A rejected card can be reopened at any time; the `ifVersion` the client sends, not the clock,
  protects it from a decision made on a stale read.

## Consequences

- A rejected card whose source Inbox item was deleted while it was locked is reopened as `proposed` when its stored
  envelope still validates: the tick never saw it, so nothing marked it `sourceDeleted`. A card the tick had marked
  `sourceDeleted` before it was discarded carries that mark and is not confirmable after the reopen.
- Follow-up processes need no cancellation, because a reject starts none.
