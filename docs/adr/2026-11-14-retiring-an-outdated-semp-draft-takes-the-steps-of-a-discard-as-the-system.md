---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Retiring an outdated Semp draft is a second caller of the discard steps, driven by the system, and leaves a draft the user worked on

## Context

When the user answers a thread on their own after Semp prepared a draft, the draft is outdated (issue gh-1902).
`retireSupersededSempDrafts` is called from the finalization of a send and from the ingest of a message of the
user's own, with no action of the user on the Semp draft. [[2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row]]
decides what a user's discard does with the draft's Emails item and `mail_drafts` row, and
[[2026-11-14-a-mail-draft-attaches-copies-of-held-files-and-trashes-the-files-that-are-its-own]] what it does with the
files. Both are written for `discardEmailDraft`. The retirement reaches the same steps (`trashLockedDraft`) from a
system-driven path, which those records do not cover, and two of its choices had a real alternative.

## Decision

**A retirement takes the steps of a discard, with the system as the writer.** Under the locks of a draft writer (the
Emails item, then the `mail_drafts` row) it trashes the draft's own files, moves the Emails item to the trash through
the choke point's soft delete and deletes the `mail_drafts` row, in the transaction of the send or the ingest that
caused it. The row is deleted for the reason of ADR 2026-11-13: the partial unique index
`mail_drafts_one_unsent_agent_per_thread_uq` holds a thread for every unsent agent draft, so a kept row would stop
the thread from taking a new Semp draft. The files are trashed by the rule of ADR 2026-11-14 (a file created after the
draft and attached to nothing else), which is why a retired draft leaves no Files item with no email behind. The
writer is `SYSTEM_WRITER`, because the user's message is the cause, not an edit of the draft. The thread is
announced after the commit.

**A retirement leaves a draft the user worked on.** It retires a draft only while both `created_by` and
`last_edited_by` are `agent`: the issue puts retiring drafts edited by the user out of scope, so a Semp draft whose
text, recipients or attachments the user changed (every draft write records its writer, the attachment routes
included) stays for the user to send or discard. It also leaves the draft that is being sent, a draft that holds a
send claim ([[2026-11-14-a-mail-draft-that-holds-a-send-claim-is-refused-to-its-other-writers]]), a draft whose source
message is as new as the user's or has no readable date, and a draft that was sent, discarded or lost its row since it
was listed.

**An ingested message is the user's own when it is filed in the Sent folder, or when its sender is one of the
mailbox's registered addresses and it is not filed in the Drafts folder.** A message in the Drafts folder is the
user's unsent work in another client and answers nothing yet.

## Alternatives rejected

- Keep the row of a retired draft with a mark. The unique index would hold the thread, and a mark needs a migration
  and a filter in every reader.
- Keep the draft's own files. A file the user uploaded for a draft that nothing will send would stay in the Files
  database with no owner that knows it, which is the reason ADR 2026-11-14 gives for a discard.
- Retire a draft the user edited. It removes the user's work because of a message the user may not have meant as its
  replacement, and the issue excludes it.
- Count only a message in the Sent folder as the user's own. A message the user sends to themselves arrives in the
  Inbox with their own address as sender, and the Sent copy of it is the same Message-ID, which ingest does not store
  twice, so the answer would never be seen.

## Consequences

- A retired draft is an Emails item in the trash with no `mail_drafts` row; restoring it does not make it editable
  again (ADR 2026-11-13), and the trashed files are restored from the trash on their own.
- The sender of an ingested message is the unauthenticated `From` header. A message that names the user's own address
  as its sender and is dated after a Semp draft's source message therefore retires that thread's agent drafts, whoever
  sent it. The effect is bounded to the unsent Semp drafts of that one thread, which Semp prepares again for the next
  message; the retirement is not undone by restoring the item. This rule does not authenticate the sender; it
  takes the sender test the issue prescribes.
