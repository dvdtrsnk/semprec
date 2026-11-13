---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# The assistant proposes a Journal merge, and an approval covers exactly the pair the user was shown

## Context

[[2026-11-10-journal-duplicate-merge-locks-the-reservation-before-both-entries]] merges the two live Journal entries of a
period that were created first. The merge re-points relation edges and moves one entry to the Trash, so it must never run
silently ([[2026-09-10-agent-writes-are-proposals-not-direct-writes]]). Approved destructive operations are replayed by
the machinery of [[2026-09-18-exactly-once-execution-of-approved-destructive-operations]]: a snapshot of the resource is
taken when the request is made and compared when the request is replayed.

## Decision

**`page.mergeJournalDuplicates` is a catalog operation that an agent's call can only queue as an approval request.** It
takes `{ type, period }` and answers `{ survivorId, mergedItemId }` or `{ merged: false }`. Its metadata is
`core.item.write` with `requiresApproval: true`, risk class `destructive` and `reversible: false`, because restoring the
trashed entry does not move the appended content and the re-pointed edges back. A person's own call (a REST session or a
human `/mcp` session, which carry no project) merges at once; the person is the one who decides.

**The request is made for a period whether or not it has a duplicate.** The projection (`journal_merge`, resource id
`<type>:<period>`) holds the period and the ids of the two entries a merge would take, or none. The description names the
period and the two stored titles, never page content. An approved request for a period that had no pair replays as
`{ merged: false }`.

**An approved request merges the pair it was shown or nothing.** The replay recomputes the projection and ends the request
as a conflict when it differs from the snapshot, which covers a pair that changed after the request. The projection reads
without locking, so the pair can still change between that read and the merge's own row locks inside the replay's
transaction. After the merge, `mergeJournalDuplicatesForWriter` therefore compares the pair it merged with the approved
one and throws a `ConflictError` on any difference. The error escapes the replay, which rolls the merge back and leaves
the request queued; the next attempt's projection then differs from the snapshot and ends the request as a conflict.

## Alternatives considered

- Taking the entry locks in the projection: rejected. The merge takes the period reservation first and the entries second
  ([[2026-11-10-journal-duplicate-merge-locks-the-reservation-before-both-entries]]); a projection that locked the entries
  first would deadlock against it, and the request-time preflight would hold locks for nothing.
- Passing the approved pair into `mergeJournalDuplicates` so it locks and checks them itself: rejected, it changes the
  merge of #1726 for one caller. The check after the merge costs one rolled-back attempt in a race that needs another
  writer to trash or create an older entry within milliseconds.
- Refusing the call when the period has no duplicate: rejected, the assistant cannot know that the user already trashed
  one, and the answer `{ merged: false }` after approval is defined by the issue.

## Consequences

- The catalog grows to 48 operations. No REST route is added for this operation.
- `refusedEdges` of the merge is logged by the merge and is not part of the operation's output.
- The Journal read-only 403 is proven with the Journal flagged sensitive; on the shipped, non-sensitive Journal a stored
  `read` row does not restrict an agent (the limit recorded by the grants model).
