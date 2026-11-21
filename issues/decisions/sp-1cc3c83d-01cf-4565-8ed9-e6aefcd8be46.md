# Decision: approve deciding an Email whose last IMAP folder copy vanished even when the pass ended early

- Question: May the proposal (sp-1cc3c83d-01cf-4565-8ed9-e6aefcd8be46) be approved as specified against the branch tip?
- Owner instruction (David, 2026-11-21): fix the findings of the local review of PR #2089 on sibling branches, one repository issue per finding under the internet-accounts epic; finding 9: an Email whose last folder copy vanished is orphaned when the pass stops before its final transaction.
- Options considered: trashing in the batch transaction (rejected: the inbox goes first, so a move by another client would become a removal and a new item); a sweep over every Email of the mailbox without a folder edge (rejected: it would decide Emails no pass observed losing a copy); a separate candidates table (rejected: a nullable column on the meta row the decision already deletes is enough, and the mark goes with the row).
- Decision: approve the specification as written: a `mail_message_meta.folder_copy_removed_at` mark written with the edge removal and decided in every pass's final transaction. The first-version rule applies: the baseline is edited in place.
- Exact spec change: none.
- Actor: claude-delegated-by-david
- Model: claude-opus-5-5
- Date: 2026-11-21
