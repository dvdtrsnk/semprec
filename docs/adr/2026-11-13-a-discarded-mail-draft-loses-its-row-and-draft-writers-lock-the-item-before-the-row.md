---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A discarded mail draft loses its `mail_drafts` row, and a draft writer locks the Emails item before the row

## Context

A mail draft that lives in Semprec is two rows: an Emails item (subject, sender, recipients and body, in the
Drafts folder) and a `mail_drafts` row keyed by the item id (structured recipients, mailbox, thread, mode,
`sent_at`; migration 0107). `mail_drafts` has no foreign key to `items`, because `items` is partitioned, so
the two rows live and die by what the code does. The draft routes (gh-1867: create, read, update, discard)
are the first writers of both rows together, and the sending of a draft (#1896) and the agent's draft tools
(#1927) will be the next. Two choices had a real alternative and were made in `mail/draft.ts`:

- **What a discard does with the row.** The Task says only that a discard "soft-deletes" the draft. The Emails
  item has to go to the trash. The row could stay, or go.
- **The order of the locks.** An update and a discard decide on the item's version (`updatedAt`) and on the
  row's `sent_at`, so they lock both. The generic item write path locks the item row first (`updateItemWithClient`,
  `itemDeleteWithClient`), and a draft write calls it after its own locks; a writer that took the row first and
  the item second would close a cycle with any of them
  ([[2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row]] was written for a deadlock of this
  shape).

[[2026-11-11-mail-purge-hook-takes-the-thread-guard-after-the-purge-locks]] and
[[2026-11-01-mail-thread-mutations-use-a-tenant-transaction-guard]] cover the mail rows of a purge and the
membership of threads. Neither covers `mail_drafts`: the purge hook names an unsent draft only as an item
with no meta row, and a draft write changes no thread membership.

## Decision

**A discard trashes the Emails item and deletes the `mail_drafts` row**, in one transaction
(`discardEmailDraft`). The row is deleted, not marked, for two reasons: the partial unique index
`mail_drafts_one_unsent_agent_per_thread_uq` holds a thread for every unsent agent draft, so a kept row would
block a new agent draft for the thread until something removed it, and a column that marks a discarded draft
would need a migration and a rule for every reader. `sent_at` is not set, because the draft was not sent.

A draft that is restored from the trash is therefore an Emails item in a Drafts folder with no `mail_drafts`
row, which is what a provider draft is: GET answers 404, PATCH and DELETE answer 409 `mail_draft_not_editable`,
and sending refuses it the same way. No Emails restore hook recreates the row; restoring does not make the
draft editable again. The permanent purge finds no row to delete for a discarded draft; the purge hook does not
delete `mail_drafts` rows, so a draft trashed some other way (the generic item delete) keeps its row, which
this decision does not change.

**A draft writer locks the Emails item, then the `mail_drafts` row.** `lockUnsentDraft` takes the item
(`lockItemById`) and then the row (`getMailDraft(..., forUpdate)`), and only then decides: 404 for no live item,
409 `mail_draft_not_editable` for no row, 409 `mail_draft_already_sent` for a sent draft, and for an update
409 `version_conflict` when `ifVersion` is not the locked item's `updatedAt`. The writes that follow
(`updateItemWithClient`, `itemDeleteWithClient`) lock the same item again in the same transaction, which
waits for nothing. Sending (#1896) and any other writer of an existing draft, a purge or restore hook that
touches the row included, take the item first and the row second, and refuse an item without a row with
`MailDraftNotEditableError` and a sent draft with `MailDraftAlreadySentError`. A create takes neither: its
rows are invisible to other transactions until the commit.

A draft writer takes no mail-thread guard. It resolves the draft's thread id and announces it, and changes no
thread membership, so it cannot interleave with a reconcile pass on thread decisions, and it holds one Emails
item, so it cannot close a cycle with the item locks of a pass
([[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]]).

## Alternatives rejected

- Keep the row after a discard, with `sent_at` or a new column set. `sent_at` would claim a send that did not
  happen, and a new column needs a migration and a filter in every reader and in the unique index.
- Lock the row first. The item is the row the generic write path, the flag sync and the trash lock first, so
  a row-first draft writer can wait on a transaction that waits on the row it holds.
- Check the version and `sent_at` without a lock. A concurrent send or edit would then pass the check and be
  overwritten.

## Consequences

- A discard cannot be undone through the draft routes. A client that wants to keep a draft does not discard it.
- Every writer of an existing draft shares one refusal order and one lock order, written down once.
- A draft trashed by the generic item delete keeps its row and, for an agent draft, its claim on the thread's
  unique index. Closing that gap belongs to the issue that gives drafts a purge or restore hook.
