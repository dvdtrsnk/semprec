---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# The invitation on an Event participant edge is written by system-kind writers only

## Context

An Event's participants are the edges of one relation definition, read from the Event as
`Events.people` and from the person as its inverse `People.events`. Both properties are user-owned:
a user adds and removes participants through the generic relation writes. Issue #1757 gives the
edge metadata a shape, `{ role?, invitation? }`. `invitation` is the state of an invitation that was
sent to the person by email (`status`, `email`, `mailboxId`, optional `sentAt` and `respondedAt`).
The calendar module's invitation code, which issues #1790, #1774 and #1950 will add, writes it.

Three facts of the existing write path shape the decision:

- A relation write replaces the whole metadata object. `createRelationWithClient` upserts with
  `DO UPDATE SET metadata = EXCLUDED.metadata`, and `updateRelationWithClient` replaces it. A user
  write that only means to set `role` would erase a stored invitation.
- [[2026-09-10-single-writer-ownership-model]] wants one writer for each piece of state and an
  explicit handoff where a second writer is needed. `owner` and `owner_process` are declared per
  property, so they cannot say that an edge is the user's while one key of its metadata is not.
- Since issue #1415 every relation write carries a writer identity whose kind is `user`, `agent` or
  `system`. The caller's composition root derives it and it is never read from a request; internal
  code that names no writer writes as `system`. Earlier rules already branch on the writer kind:
  [[2026-11-04-flagged-agent-writes-require-approval]] defers a flagged write of an agent with a
  run and leaves user and system writes alone,
  [[2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits]] breaks value
  links on a user or agent edge insert or delete and leaves them on for a system write, and the
  Tasks pre-write transform refuses the status `missed` from a writer that is not `system` (issue
  #1668), a value that only a system-kind writer may write, as here. This decision is the first to
  refuse part of a relation edge's metadata on the writer kind.

Two alternatives were rejected. A separate system-owned relation or table for invitations would
repeat the participant edge and would have to be kept in step with it. Merging a public write's
metadata into the stored object inside the choke point would change the replace contract of every
relation.

## Decision

**The handoff.** The `invitation` object in a participant edge's metadata is handed to the calendar
module. The edge itself and its `role` stay the user's to write. The handoff is recorded in the
header comment of `backend/packages/data/src/calendar/calendarModuleManifest.ts`.

**Enforced on the writer kind, in an edge write hook.** `eventParticipantEdgeWriteHook`
(`backend/packages/data/src/calendar/eventParticipantEdgeHook.ts`) is a relation-edge-write hook of
[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]. For a write whose writer
kind is not `system` it requires the `invitation` the write carries to be deeply equal to the stored
one, where an edge without a stored invitation equals a write without one. A `user` or `agent` write
that adds an invitation, changes it or leaves a stored one out is refused with `validation_failed`
on `metadata`, reason `invitationReadOnly`. Nothing is merged and nothing is silently kept: the
caller sends the stored invitation back or the write fails. A `system` write may store any
invitation of the defined shape.

The hook checks the writer kind, not an owner process. Every internal caller that names no writer
passes the check. That the invitation code is the only internal code to write an `invitation` is
held by the manifest record and by review, not by the hook.

**Both properties of the definition.** The hook applies to the relation definition one of whose
properties is the `people` property of the Events system database, whichever of its two properties
the write names. A write through `People.events` is judged exactly like a write through
`Events.people`.

**Item ids in one text form.** The hook finds the stored edge by comparing the Event id and the
person id of the write with the ids of the Event's stored edges, as text. Postgres reads a uuid in
more text forms than the one it returns: in braces, and with hyphens left out or placed after any
group of four digits. The relation write hands the caller's ids to Postgres as they came, so its
upsert meets the stored edge whatever form the id has. The hook therefore accepts an id only in the
8-4-4-4-12 form, in either letter case, and compares it in lower case, which is the text Postgres
returns. A write on this relation that names the Event or the person in another form is refused with
`validation_failed` on `callerItemId` or `targetItemId`, reason `nonCanonicalItemId`, whatever the
writer kind and the metadata. Without this rule the hook would find no stored edge for a write that
names the person in such a form, judge it as the first write of the edge, and let its upsert replace
the stored metadata, the invitation included.

**Rules that hold for every writer, `system` included.** The metadata has no key other than `role`
and `invitation`, `role` is `organizer` or `attendee`, and `invitation` has the defined shape
(reason `invalidParticipantMetadata`). An organizer edge carries no invitation (the same reason),
points at the person linked to the tenant's user through `System settings.selfPerson`
(`organizerNotSelf`, also when no person is linked), and is the Event's only organizer edge
(`organizerAlreadySet`). Absent metadata and `{}` are valid and mean an attendee without an
invitation, so every edge stored before this decision stays valid.

**The hook locks the Event row.** After the shape check and before it reads the Event's edges, the
hook takes the Event's row lock with `SELECT … FOR UPDATE` (`itemsStore.lockItemById`). Two writes
of participant edges of one Event that both take this lock therefore run one after the other, and
the second reads what the first committed. Without the lock a public write could read that no
invitation is stored while a system write of the same edge was still uncommitted, and then replace
it. One kind of insert-only write takes no lock; the next paragraph says which and why. When the
write runs under the value-link admission of
[[2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits]]
(`lockMode: "nowait"`), the hook follows item 3 of that decision: it validates the metadata first,
takes the same row lock with `NOWAIT`, and a held row surfaces as `ValueLinkBusyError`. An Event id
that names no row, which is the case for the placeholder caller of an item that is only proposed,
locks nothing and has no edges.

**An insert-only write says so.** `createRelationIfAbsentWithClient`
([[2026-11-06-speaker-confirm-inserts-participants-without-metadata-replacement]]) passes
`insertOnly: true` in the hook context; no other caller sets it. The participant hook accepts an
insert-only write that carries no `invitation` even when the edge stores one, because that write
stores nothing over an existing edge. An insert-only write that does carry an `invitation` is judged
like any other write, so it cannot add one when the edge turns out to be absent.

An insert-only write that carries no `invitation` and is not an organizer edge takes no Event row
lock and reads no edges: the hook returns after the shape check. Nothing about such a write is
decided from the Event's edges, and it stores nothing over a stored edge, so a stored invitation
survives it without the lock. The reason is the order of two locks. The speaker confirmation makes
exactly this write after it wrote its `Transcripts.speakers` edge, and that edge queued the person's
People `lastContact` recompute (issue #1660) under the job key `people-last-contact:<personId>`. A
second transaction that queues the same key waits until the first ends. An update of the Event
takes the two in the other order: the Event's row lock first, then that job key for every
participant when `date` or `timeFrom` is patched. A row lock in the confirmation's insert would
therefore deadlock with an update of the Event whenever the confirmed person already takes part in
it. [[2026-11-06-speaker-confirm-inserts-participants-without-metadata-replacement]] decided that
this insert adds no locks, and it still adds none. An insert-only organizer edge, and an insert-only
write that carries an `invitation`, take the lock like any other write.

## Consequences

- A client that changes the role of an invited participant sends the stored `invitation` back
  unchanged in the same `PUT`. A client that sends only `role` gets `invitationReadOnly`.
- A generic relation write names the items of a participant edge in the 8-4-4-4-12 form. The other
  relations still take every text form of a uuid that Postgres reads; the rule is the participant
  hook's, not the choke point's.
- An edge removal runs no write hook, so it is not judged and takes no Event row lock. A user can
  remove an invited participant's edge and add the person again without an invitation. Issue #1757
  runs the hook on an add and on a metadata replace only.
- A participant edge write that takes the Event row lock waits for another such write of the same
  Event and for any other transaction that holds the Event's row lock, such as an update of the
  Event. It is not ordered against an edge removal, nor against an insert-only write that takes no
  lock.
- A participant edge write that takes the Event row lock holds it until its transaction ends. It
  takes the lock before the edge row is written, and so before the `lastContact` job key that the
  write's changed-edge hook takes for the person: the order of an Event update, the Event row and
  then the job keys of its participants.
- A transaction that already holds a person's `lastContact` job key from an earlier write, and then
  makes a participant edge write that takes the row lock of an Event that person already takes part
  in, takes the two in the opposite order. It can deadlock with an update of that Event; PostgreSQL
  ends one of the two with a deadlock error. The speaker confirmation was the one fixed sequence of
  that shape and takes no lock (above). A transaction that composes several writes, such as a
  multi-step proposal confirm, can still take them in that order.
- The checks that write nothing (`assertRelationCreatableWithClient`,
  `assertRelationTargetLinkableWithClient`) run the same hook and take the same row lock until their
  transaction ends.
- Internal callers that move or copy edges with their stored metadata and name no writer, such as
  `moveRelationEdgesWithClient`, write as `system` and carry an invitation along.
- A stored edge whose metadata holds another key, written before this decision, is refused on its
  next metadata write until the write carries only `role` and `invitation`. Reads
  (`readEventParticipantMetadata`) treat a stored role outside the two roles as `attendee` and a
  stored invitation of another shape as none.
- `RelationEdgeWriteHookContext` has the optional field `insertOnly`. A hook that ignores it behaves
  as before.
- This decision registers no writer of `invitation`. The invitation code and its `sentAt` and
  `respondedAt` writes are issues #1790, #1774 and #1950.
