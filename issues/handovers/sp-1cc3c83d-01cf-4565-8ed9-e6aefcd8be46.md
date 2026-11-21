# Handover: decide an Email whose last IMAP folder copy vanished even when the pass that removed it ended early

Commit on `fix/ia-mail`: `8485b1d23`. Nothing was run against a real server.

**Root cause.** `reconcileImapAccount` committed each folder batch's removal of a vanished UID's folder edge but kept the affected Emails only in memory (`copiesRemovedFrom`) for its final transaction. A pass that ended before that transaction (a later folder's fetch failed, the lease was lost, Mail was switched off) left the Email with no folder edge and not trashed, and no later pass looked at it again.

**Changes.**
- `0001_baseline.sql`: `mail_message_meta.folder_copy_removed_at timestamptz` (commented) and the partial index `mail_message_meta_folder_copy_removed_idx (tenant_id, mailbox_item_id) WHERE folder_copy_removed_at IS NOT NULL`.
- `mail/mailMessageMetaStore.ts`: `markMailMessageFolderCopyRemoved`, `listMailMessagesWithFolderCopyRemoved`, `clearMailMessageFolderCopyRemoved`.
- `mail/imapReconcile.ts`: the batch that removes an edge marks the Email in the same transaction; `removeEmailsWithoutFolderCopy` decides the pass's own Emails and every marked Email of the mailbox: no edge and no move in flight → trashed with its meta row; a copy left → kept and mark cleared; a move in flight → mark kept.
- `testSupport/fakeImapAccount.ts`: `expunge` and `move` as another client does them.
- `docs/architecture/domain-mail-and-inbox.md`: the vanished-UID paragraph.

**Tests** (`__tests__/imapServerDeletions.test.ts`, one table): a message expunged, or moved to Archive, by another client while the pass that removed its INBOX copy fails before any other folder is selected is, at the next pass, trashed with no folder (expunged; failed before the fix) or kept on the same item in Archive (moved), with no mark left.

**Left.** A marked Email of a mailbox that is removed before any pass decides it stays without a folder edge; the removal job selects members through folder edges.
