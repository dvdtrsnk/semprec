---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Mail thread refs store the given id and resolve label and state at read time

## Context

[[2026-11-06-semp-reference-reads-stay-in-data-owners]] says the history label reader performs at most one resolver statement per nonempty kind and that the label of an item, block or transcriptSegment ref is the item's title property; [[2026-11-06-semp-refs-validate-observed-tenant-state]] says refs are validated in batches by kind. Neither says what the label, the state and the database key of a `mailThread` ref are. A thread is not an item a client can address: its public id is the thread id in `mail_threads`, and a merge (`reassignThread`) can leave a thread id only as a row of `mail_thread_aliases`. A thread has no title property, and its messages are items of the Emails database that can each be in the Trash or have no folder at all. Issue 1933 adds the kind, and its Task decides only the three outcomes (subject, `trashed` when all messages are in Trash, `purged` for an unknown id). The cases below are left open by the Task and are decided here, in the way [[2026-11-13-transcript-segment-refs-resolve-in-batches-and-are-labelled-by-display-name]] decided them for its kind.

## Decision

This narrows the two reads and validation decisions above for the `mailThread` kind only; every other kind, the batching rule and the per-ref unavailable contract stay as they are.

- Stored as given: a ref is stored with the thread id the client sent, never rewritten to the current thread id. Validation accepts an id that is a live thread of the caller's tenant or the alias of one, and refuses any other id, including the id of a Threads item. Aliases are one step (`reassignThread` keeps them flat), so one join resolves them. The dedup identity of a ref (`messageRefKey`) is the id as given, so a merged-away id and the id of the thread that absorbed it are two refs. Why: the history record of what the user dragged in must not change when a merge happens later, and a stored translation would go stale when the thread is merged again.
- Translated at read time: the history label, the state and the expansion for the agent all resolve the id through the aliases when they are read. The expansion hands the agent the current thread id (`details.threadId`), which `mail.thread.get` reads. The translation lives in one owner, `mail/mailThreadRef.ts`, and its read is one statement per batch of ids whatever their number.
- Label: the subject of the latest live message of the thread, where live means the message item is not soft-deleted and drafts count (the set the thread detail reads), latest by activity (the message's `date`, else its ingest time, else its update time), the higher item id breaking a tie. A thread with no live message falls back to `mail_threads.subject_hint`; a thread with neither has a null label. Why: a thread has no subject of its own, and the latest message is what the thread list shows. The expansion cuts the label to 500 code points like the other kinds.
- State: a thread is `trashed` when it has no live message copy, or when it has live copies and each of them has live folders that are all Trash folders (`specialPurpose` `trash`; a deleted folder is no live folder). A copy with no live folder is not in the Trash. Otherwise the state is `active`. An id that is neither a live thread nor an alias is `purged` with a null label. Why: "every message of the thread is in the Trash" is vacuously true of a thread whose messages were all removed, and showing such a thread as active would label an empty thread as live.
- Database key: always null. A thread belongs to no database a client can open, and the Emails key of one of its messages would name a place the thread ref does not lead to.

## Consequences

A reader of the reads ADR must take this one with it for `mailThread`: its label is not a title property, its state is derived over all live copies, and the target of a stored id can change under it when a merge or a restore happens, because nothing is frozen at send time. The label, state and expansion of a history page of any number of thread refs cost one resolver statement for the page. A thread restored from the Trash returns to `active` without a rewrite. Tests prove validation of a direct id, an alias and an unknown id, the label source and its fallback, the states `active`, `trashed` and `purged`, the no-live-copy case, and the translation of a merged-away id in history and expansion.
