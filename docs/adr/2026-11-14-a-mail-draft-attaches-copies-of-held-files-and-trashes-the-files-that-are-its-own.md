---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# A mail draft attaches a copy of a file another email holds, and a discard trashes the files that belong to the draft alone

## Context

A draft can carry attachments (issue gh-1895). The relation `Emails.attachments` is `one_to_many` and owned by the
Emails module process (`seed/seedEmailModule.ts`, `EMAILS_RELATION_CONTEXT`): a Files item is held by one email, and
only the module's writer writes the edge. Files reach a draft by upload (`POST /api/files`, a Files item with no
relation) or by a copy of a message's attachment, which the forward of issue #1899 will attach. Two things had a
real alternative: what attaching does with a file another email holds, and what a discard does with the files of the
draft. [[2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row]] decides
what a discard does with the draft's own two rows and says nothing about files.

## Decision

**A file that another email holds is copied, not moved.** `attachFileToDraft` creates a new Files item over the same
blob (`properties.file.blobId`) and attaches that one. The original keeps its edge, so the other message keeps its
attachment. A file that no email holds is attached itself, and a file that is attached to the draft already changes
nothing. The blob is shared, so the copy costs no bytes and the size limit counts the file's recorded size, not
a second copy of it. A repeated post of a held file also changes nothing once the draft lists a file of the same name
over the same blob, so a retry or a double click does not add a second copy or count its size twice.

**A discard trashes the attached files that were created after the draft and have no relation edge to any item
other than the draft.** In `discardEmailDraft`, after the draft is locked and before its Emails item is trashed,
`deleteFilesOfDiscardedDraft` lists the live Files items attached to the draft and soft-deletes, through the choke
point's item delete, each one that was created after the draft's Emails item and has no edge in either direction to
an item other than the draft: an upload made for the draft, and a copy made by the attach. A file with any other
edge, such as a project, a task or another email, stays, and so does every file that was detached before the discard.
A file created before the draft is one the user already had, and stays: an upload for a draft is made after the
draft exists, and so is the copy `attachFileToDraft` creates. The rule stands for "uploaded to the draft and attached
nowhere else" because nothing records where a Files item came from, and a new column or table to record it would add
a migration this change has no other reason for.

**The lock order is the draft's Emails item, its `mail_drafts` row, then the Files item.** Attach locks the file
before it reads who holds it, so two attaches of one file to two drafts serialize: the second finds the first edge
and copies. A discard reaches the files through the item delete, which locks each of them after the draft's two
rows, as an attach does.

## Alternatives rejected

- Move the file to the draft by removing its old edge. The other email would lose an attachment it displays, and the
  edge is the Emails module's to write for that email.
- Refuse a file another email holds. A forward needs that file on the new draft.
- Keep the files when a draft is discarded. A file uploaded for a draft that is thrown away would stay in the Files
  database with no email and no owner that knows it.
- Record the draft an upload was made for. It needs a new column or table; the edge test and the creation time need
  neither and cover the copies as well.
- Trash every attached file that has no other edge, whenever it was created. A document the user had in the Files
  database for months and attached to a draft would be sent to the Trash by a discard of that draft.

## Consequences

- A Files item that a user created with no relation to anything after the draft existed, and then attached to it, is
  trashed when that draft is discarded. It can be restored from the Trash like any trashed item; the restore of the
  draft does not restore it.
- A file uploaded before the draft was created and then attached to it is not trashed by the discard, though it was
  uploaded for the draft. Keeping a file is the safe side of the guess; tidying it is the user's.
- A copy that is detached stays as a Files item with no email. Only a discard removes the files of a draft; a detach
  removes the edge alone.
- A file that has any other edge survives every discard. Tidying such a file is the user's.
