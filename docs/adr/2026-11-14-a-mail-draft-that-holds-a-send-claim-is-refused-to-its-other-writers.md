---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A mail draft that holds a send claim is refused to its other writers, and the claim transaction decides on the locked draft

## Context

`sendDraftEmail` (issue gh-1896, `POST /api/mail/drafts/:id/send`) claims a draft before it calls the provider: the
claim is the draft item's `mail_message_meta` row, written in its own transaction, and the finalizing transaction
(a later transaction, after the provider took the message) sets `mail_drafts.sent_at` and moves the item to Sent. The
transactions are separate because nothing may be held open across a provider call.
[[2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row]] says a send takes
the item first and the row second and decides on them, and that a check without a lock is rejected. Two gaps were
left:

- The send route read the draft in one transaction and committed; the claim transaction then ran without a lock on the
  item or the row. A discard or an edit committed in that window was not seen, so a discarded draft was delivered, and
  the finalization then failed with 404 for a message that went.
- Between the claim and the finalization `sent_at` is still null. `lockUnsentDraft`, which an edit, a discard and an
  attachment change use, decides on the item's `deletedAt`, the row and `sent_at` only, so it passed a draft whose
  message was being delivered.

## Decision

**The claim transaction locks the draft's Emails item, then its `mail_drafts` row, and decides on them.** Before it
writes the claim it refuses an item that is missing or in the trash (404) and a row whose `sent_at` is set
(`MailSendClaimLostError`, which the route answers as 409 `mail_draft_already_sent`). `sendDraftEmail` takes an
optional `beforeClaim` guard that runs there, under those locks; the send route uses it to read the draft again
(`prepareSend`) and refuses with 409 `version_conflict`, sending nothing, when the draft would no longer be sent as it
was first read (recipients, subject, body, attachments, reply headers). What is delivered is what the draft held when
the claim committed. The lock order is the one of ADR 2026-11-13: the item, then the row.

**A draft that holds a claim is refused by every other writer as a sent draft.** `lockUnsentDraft` answers a draft
whose item has a `mail_message_meta` row with `MailDraftAlreadySentError` carrying `{ emailId, threadId }`, as it does
for a draft with `sent_at` set, and `retireSupersededSempDrafts` skips such a draft. A send that fails undoes its claim
in a transaction of its own, which makes the draft writable again; a send whose finalization fails keeps its claim, as
it kept it before, and the draft stays refused.

## Alternatives rejected

- Hold the item and row locks from the first read to the finalization. That pins a pooled connection and the locks for
  the whole provider call, and a transaction must not be held open across slow external work (`state-writes`, §4).
- Add a "sending" state to `mail_drafts`. The claim row already arbitrates two sends by the primary key of
  `mail_message_meta`, and a second marker would need a migration and a rule for every reader to keep in step with it.
- Keep reading the draft without a lock in the claim transaction. A concurrent discard or edit would then pass, which
  ADR 2026-11-13 rejects for the same reason.

## Consequences

- A client that edits or discards a draft during the provider call is answered 409 `mail_draft_already_sent`, though
  the send may still fail and undo its claim; it can read the draft to learn which.
- A draft trashed by the generic item delete, which does not go through `lockUnsentDraft`, between the claim and the
  finalization still fails the finalization with 404 for a message that went. Closing that gap belongs to the issue
  that gives drafts a trash hook (see the last consequence of ADR 2026-11-13).
- Any future writer of an existing draft takes the locks in the same order and refuses a claimed draft, which
  `lockUnsentDraft` does for it.
