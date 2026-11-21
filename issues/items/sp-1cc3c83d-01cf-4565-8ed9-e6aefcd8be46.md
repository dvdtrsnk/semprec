---
schemaVersion: 1
id: "sp-1cc3c83d-01cf-4565-8ed9-e6aefcd8be46"
title: "[internet-accounts] Decide an Email whose last IMAP folder copy vanished even when the pass that removed it ended early"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["spec:approved"]
parent: "sp-85e6cbc4-7de7-4385-81a9-a493c421b817"
assignees: []
milestone: null
createdAt: "2026-11-21T21:27:33.606Z"
updatedAt: "2026-11-21T21:33:02.328Z"
closedAt: "2026-11-21T21:33:02.328Z"
source: null
approval: {"specSha256":"501df13ecda71e9b4d7cca4b2a1ef864e00b88be6564790726c33160f9a09a97","source":"repository","actor":"claude-delegated-by-david","at":"2026-11-21T21:27:49.442Z"}
resolution: {"pullRequests":[],"commit":"8485b1d23843ba6203375204add0aabe4cf49a1c","at":"2026-11-21T21:33:02.328Z"}
---
**Blocked by:** none
**Model tier:** high

## Context

Model tier rationale: Makes the IMAP pass's decision on Emails whose last folder copy vanished durable across passes, with a schema column, without breaking the rule that a move by another client keeps its item.

Found in the local review of PR #2089. In `reconcileImapAccount` (`mail/imapReconcile.ts`) each folder batch commits the removal of a vanished UID's Emails–Folders edge, but the Emails it removed an edge from are only collected in memory (`copiesRemovedFrom`) and decided in the pass's final transaction (`removeEmailsWithoutFolderCopy`). A pass that ends before that transaction (a later folder's fetch fails, the connection drops, the lease is lost, Mail is switched off) leaves an Email whose last copy is gone with no folder edge and not trashed. No later pass finds it again, because only the vanished UID led to it.

Decisions:

- The batch that removes the edge also marks the Email's meta row (`mail_message_meta.folder_copy_removed_at`, new nullable column with a partial index on `(tenant_id, mailbox_item_id)`), in the same transaction.
- The final transaction decides the pass's own Emails and every marked Email of the mailbox: no folder edge and no unsettled or protected move → trashed with its meta row (mark gone with it), as before; a folder copy left (a move whose target this pass ingested) → kept and mark cleared; a move in flight → mark kept for a later pass.
- Trashing in the batch transaction was rejected: a move by another client shows as the target folder's new UID and the source's vanished UID, and the inbox goes first, so the source copy is often removed before the target copy is ingested; trashing then would turn every such move into a removal and a new item.
- A marked Email of a mailbox that is removed before a pass decides it stays as it is (out of scope).

## Task

Load `state-writes`, `db-migrations`, `error-handling`, `testing`.

1. `db/migrations/0001_baseline.sql`: `mail_message_meta.folder_copy_removed_at timestamptz` with a column comment and the partial index.
2. `mail/mailMessageMetaStore.ts`: mark, list (per mailbox) and clear functions.
3. `mail/imapReconcile.ts`: mark in the batch that removes the edge; `removeEmailsWithoutFolderCopy` decides the union of the given and the marked Emails and clears the mark of one that keeps a copy.
4. `testSupport/fakeImapAccount.ts`: `expunge` and `move` as another client does them.
5. Tests in `__tests__/imapServerDeletions.test.ts`.
6. Update `docs/architecture/domain-mail-and-inbox.md`.

## Touches

- backend/packages/data/src/db/migrations/0001_baseline.sql
- backend/packages/data/src/mail/imapReconcile.ts, mailMessageMetaStore.ts
- backend/packages/data/src/testSupport/fakeImapAccount.ts
- backend/packages/data/src/__tests__/imapServerDeletions.test.ts
- docs/architecture/domain-mail-and-inbox.md

## Scope

### In scope

- The durable mark and its decision in the final transaction of an IMAP pass.

### Out of scope

- The Gmail and Graph passes; the mailbox removal and Mail-off jobs; any sweep over unmarked Emails without a folder edge.

## Acceptance criteria

- A message expunged by another client whose INBOX copy was removed by a pass that then failed before its final transaction is trashed with no folder edge at the next pass, and no mark is left.
- A message moved by another client from INBOX to Archive in the same situation keeps its item, now in Archive, and no mark is left.
- The existing server-deletion, mail sync and move-sync tests stay green.
