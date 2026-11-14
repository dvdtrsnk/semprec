---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A transcript card is recomputed by `semprec-transcribe`, its producer, when the user gives an instruction

## Context

The Inbox card of a recording (the card of its Event, or of one of its speakers) can be corrected by
the user in words: "it was the call with the accountant". Issue #1870 mounts
`POST /api/proposals/:id/revise` and, for a transcript card with a message and no envelope, only
records the message in the card's history. Nothing acts on it yet.

Acting on it takes one paid model call and a write of the card's assistant side (`aiProposal`,
`aiVersion`), of its effective `proposal` and of its `history`. The card model of the Inbox work
already says what that write must keep: the user's manual values (`userOverrides`,
`userEditedKeys`) survive a change of the assistant's output
([[2026-09-23-processing-proposals-card-creation-owned-per-kind]] gave the cards to their producers,
and [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]] made
`semprec-transcribe` the one producer process of `transcript` cards).
[[2026-09-23-transcription-worker-writes-event-match-results]] and
[[2026-11-13-transcription-recommends-the-event-of-an-ambiguous-recording]] already let that process
write cards and call the gateway outside a transaction.

Alternatives for who makes the call: the revise route (a paid call held inside an HTTP request that
also has the card's row lock, or run before the transaction without a way to retry it), the Inbox
pipeline's tick (it recomputes `inbox` cards from their Inbox item and knows nothing of transcripts,
their candidates or their meeting notes) and `semprec-agents` (a second process writing a card it
does not produce). None keeps the paid call and the write of the card in the process that already
owns the card's kind.

## Decision

- **The instruction becomes a job in the transaction that records it.** The message-only branch of
  `reviseProposalWithClient` gives the history entry of the instruction an `id` and, in the same
  transaction, enqueues the core task `transcriptCardRecompute` with payload
  `{ proposalId, instructionEntryId }`, job key
  `transcript-card-recompute:<proposalId>:<instructionEntryId>`, `maxAttempts: 3` and the tenant's
  lane. A locked card, a card whose source was deleted and a card of another kind are refused by the
  revise, so they enqueue nothing. The job carries ids only: the instruction's text
  is read from the card's history.
- **`semprec-transcribe` rewrites its own cards on request.** It writes the card's `aiProposal`,
  `aiVersion`, `proposal`, `userOverrides`, `userEditedKeys`, `status`, `invalidReason` (cleared) and
  `history`, through `updateItemWithClient`, under the card's row lock
  (`lockItemById`, `FOR UPDATE`), and only for a card of kind `transcript` that is not `confirmed`,
  `rejected` or invalid because its source was deleted. It never writes a card of another kind and
  creates nothing. The production sites of [[2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards]]
  (the table of producers) are unchanged: this is no new way to create a card. Confirm, reject and
  the revise itself stay with the proposal actions.
- **The task is bracketed like the other model steps of this process.** A repeatable-read snapshot
  without locks reads the card, its transcript (display name and meeting notes), the card's
  candidates and its `aiVersion`, and ends the task when the card is locked, gone, of another kind or
  already answered. The gateway call (`operation: 'transcript_card_recompute'`, no project,
  `temperature: 0`) runs outside any transaction. One transaction then locks the card, checks again
  everything the snapshot decided on, and throws when `aiVersion` is no longer the snapshot's, so the
  job runs again against the card as it is. The write holds the card's lock from that check to the
  commit. Validating the new envelope (`assertValidEnvelopeForCard`) reads the rows it needs, and for
  a speaker mapping it row-locks the transcript after the card, the order of confirm
  ([[2026-11-12-a-manual-speaker-assignment-settles-the-key-card-in-the-confirm-lock-order]]).
  Jobs of one tenant share one lane and the runner has one slot, so they normally run one at a time;
  the `aiVersion` check, not that, keeps two overlapping runs from overwriting each other.
- **What the model may answer.** Only a choice among the candidates already on the card
  (`context.candidates` of an Event card, `context.alternatives` of a speaker card) and the card's
  current target as a `relation`, or an edit of the fields of the card's current new-item proposal
  (`database`). The role of a card never changes: a result that would turn an Event card into a speaker
  mapping or the reverse fails the card's own validation. An answer that is not usable, that fails
  these checks or that the validation refuses leaves the proposal as it was; so does the model's
  statement that the instruction cannot be satisfied. Each adds one `threadRevision` history entry
  that says so.
- **User-edited keys are protected.** The answer is stored as the assistant's output and the
  effective `proposal` is composed from it with the card's manual values laid over it, as for a
  revision made in an Inbox item thread (`retainOverridesForThreadRevision`,
  `composeEffectiveEnvelope`): a key the user edited keeps their value unless the model lists it in
  `explicitlyChangedKeys`, which it may do only for a field the instruction names; the key then stays
  in `userEditedKeys`. Another target drops every manual value and a `reset` entry lists the keys.
- **An instruction is answered at most once.** The entry that answers it has kind `threadRevision`
  and the instruction's `instructionEntryId`, whatever the outcome (applied, unchanged, discarded or
  failed for good). The snapshot and the write both treat such an entry as "done", so a job retried
  after the write makes no second call and adds no second entry. A job whose attempts are used up, or
  that the gateway refused for the budget, leaves the card as it was and adds the entry that the
  instruction could not be applied.
- **No content in logs.** The task logs ids, an outcome and an error code. The instruction, the
  transcript and the model's answer are never logged, and the error a failed attempt raises carries a
  code only. The model's reason is kept in the history entry, bounded to 300 characters, and is asked
  not to quote the recording.
- **A third runner.** `semprec-transcribe` runs the task on a runner of its own with one slot, beside
  the media pipeline's and the fast row creation's, so a short model task waits behind neither
  ([[2026-11-05-recording-intake-preserves-fast-create-jobs]]).

## Consequences

- A transcript card is written by two kinds of caller after its creation: the proposal actions
  (confirm, reject, revise, value edits) and this task. Any further writer of a transcript card's
  assistant side belongs in `semprec-transcribe` too, and any card write that follows the lock order
  above (card first, then the transcript) stays free of deadlock with these two.
- A card's `history` gains `id` on a user's instruction to a transcript card and `instructionEntryId`
  on its answer. Both are optional, so existing entries and readers are unchanged.
- An instruction costs one paid call, and a crash between the call and the write can repeat it. A
  card the user edited during the call is not overwritten: the write composes with the manual values
  of the locked row, not of the snapshot.
- The instruction is answered after the user has seen it recorded; a client sees the card change
  through the card's invalidation, and a card that could not be changed says so in its history.
- Free search over Events and People for the answer, the recompute of `inbox` cards and the undo of a
  decided card are not decided here.
