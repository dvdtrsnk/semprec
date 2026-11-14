---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A mail thread move records the desired provider move before it replaces the folder edge, and writes the new edge without a UID

## Context

[[2026-11-03-mail-moves-use-durable-step-claims-outside-transactions]] gives a provider move a durable row
(`mail_message_move_sync_state`) that sync executes later, and makes `recordDesiredMailMessageMove` the
writer of the desire. Until the thread routes (`POST /api/mail/threads/:threadId/archive`, `/trash`,
`/restore`) nothing but tests called it. These routes are the first writers that record a desire for a
user action and, in the same transaction, replace the `Emails.folder` edges of the copy as the Emails
module (`EMAILS_RELATION_CONTEXT`). [[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]]
fixes the lock order of a thread action (guard first); it says nothing about the order of the desire and the
edge, or about what the new edge carries.

Three facts of the store decide the shape of such a writer:

- `recordDesiredMailMessageMove` verifies an IMAP source (folder, path, UID, `UIDVALIDITY`) against the
  copy's current folder edge, which carries the UID in its metadata. Once the edge is replaced the evidence
  is gone.
- The new edge is written by the thread action, not observed at the provider, so it has no UID.
- While an earlier desire of the copy is `pending` or a provider operation is outstanding, a new desire
  keeps the source evidence of that row and ignores the one it is given.

A restore route, or any later move route, that does not know these three facts either fails with a 500 or
records evidence nobody verified.

## Decision

A thread action that moves copies does so in one tenant READ COMMITTED transaction, in this order, and the
only code that implements it is `applyMailThreadMoves` (`mail/mailThreadActions.ts`). A later move route
calls it and does not repeat the steps.

1. The thread guard first (`resolveMailThreadForAction`), as in
   [[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]]; then the selection of
   the copies and the target folder of each copy in its own mailbox (`planMailThreadMoves`). A mailbox
   without the folder fails the whole call with a 409 of that purpose.
2. The source of every copy is resolved before the first write (`resolveMoveSource`): a Gmail API or Graph
   copy by its provider message id, an IMAP copy by the one edge that carries a UID. A copy that cannot be
   addressed, or whose mailbox has no sync state, fails the whole call with 409
   `mail_move_source_unverified`. The reason is that a refusal is then decided while no copy has changed, and
   a call that fails changes nothing.
3. Per copy, in the order of the plan, the desire is recorded first (`recordDesiredMailMessageMove`), then all
   the copy's folder edges are deleted and one edge to the target folder is created, as the Emails module,
   with no metadata. The desire comes first because the store verifies an IMAP source against the edge that
   is about to go; recorded after the replacement, it would find no edge with a UID.
4. The account sync of every touched mailbox is enqueued once, in the same transaction
   (`enqueueMailAccountSync`), and one `mailThread` invalidation goes out after the commit.

The new edge has no UID, so a second move of the same IMAP copy cannot read a source from it. It succeeds
only while the first desire keeps its evidence (the row is pending or an operation is outstanding), and
fails with 409 `mail_move_source_unverified` otherwise, until sync observes the copy at the provider and
gives its edge a UID. Whether a desire keeps its evidence is decided by one function of the store
(`keepsEarlierMoveSource` in `mail/mailMessageMoveSyncStore.ts`), which both `recordDesiredMailMessageMove`
and `hasPreservedMailMoveSource` (the helper step 2 uses to decide whether a copy needs a source) apply, so
the writer and its pre-check cannot disagree.

## Consequences

- A refusal of the thread action (a missing target folder, an unaddressable copy) rolls the transaction
  back: no edge, no move row, no queued sync and no invalidation change.
- A user can move an IMAP thread again at once, for example archive and then trash, only because the first
  desire is still pending. When sync has already completed it but not yet observed the copy, the second call
  answers 409 `mail_move_source_unverified`. That 409 is not in the issues that define the routes; it is
  the price of never recording a source that was not verified.
- A new move purpose changes `MailMovePurpose` and `MOVE_TARGET_MISSING` together; the type makes the
  compiler point at the second.
- A change of the keep-the-evidence rule is a change of `keepsEarlierMoveSource` and of the sync-side
  contract in [[2026-11-03-mail-moves-use-durable-step-claims-outside-transactions]], not of the thread
  action.
