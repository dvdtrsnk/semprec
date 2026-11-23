---
status: accepted
date: 2026-11-23
area: [mobile]
supersedes: []
superseded-by: null
---

# Mobile writes wait in an ordered queue without a connection

## Context

Since [[2026-11-23-mobile-keeps-the-answers-of-the-offline-set]] the screens of the offline set read without a
connection, but every write still failed: a task could not be completed, an event not moved, a project not added.
Every write goes through `AuthenticatedApi.send` and the repositories build their requests and decode the answers
(`ItemWrites`, `HttpCollectionWrites`, `HttpCalendarRepository`, `HttpItemRepository`, `HttpInvitationRepository`,
`HttpJournalRepository`, `HttpInboxCaptureRepository`). Several writes are a sequence whose later request names what
the first created (a task, then its repetition; an occurrence stored, then moved). `POST /api/databases/:id/items`
answers a repeated `Idempotency-Key` with the item it already created; `PATCH /api/items/:id` takes `ifVersion` and
answers `409` when it is stale.

Rejected: queueing domain operations (complete this task, move that event) and replaying them through the
repositories. Every repository would need an operation type, its serialization and its replay, and the sequence
writes would be decided twice. Queueing the requests the repositories already send replays exactly what an online
app sends, and the only thing the device has to make up is the answer.

## Decision

- **Queued routes.** `POST /api/databases/:id/items`, `PATCH` and `DELETE /api/items/:id`, the relation and value-link
  writes of an item, the storing of a series occurrence (`POST /api/events|tasks/series/:id/occurrences/:date`), a
  task's repetition and host event, an invitation's answer, an Inbox capture (`POST /api/inbox/items`) and the ensuring
  of a diary period's page (`PUT /api/journal/periods/:type/:period/doc`) (`QueuedRoute`). Every other write goes to the
  server as before. `POST /api/calendar/items/:id/duplicate` is not queued, because the server cannot recognize it
  when it is sent twice.
- **Made-up answers.** A queued write answers what `QueuedAnswers` makes up, so the repository decodes it as the
  server's: a created item carries an id made on the device, a changed item is the newest kept one with the change in
  it, and the writes that answer no body answer an empty one. A create without an `Idempotency-Key` gets one before its
  first attempt, so a repeat after a lost answer creates nothing.
- **When a write waits.** With nothing queued and the process not offline, a queued route is sent directly and only
  waits in the queue when it gets no answer, a `5xx` or a `429`; any other answer is returned as it came. While the
  process is offline it is queued at once. While other writes wait and the server can be reached, it is queued behind
  them and its caller waits up to 10 s for its own answer, so the order of writes is kept and the server's answer and
  refusal reach the caller whenever they can.
- **The queue** of an account lives in `<account>/queue.json` of the offline store: the writes in order with the
  request, the id made on the device, the attempts and the queue time; the server id of each id made on the device
  once its write was answered; the dropped ids; the failures. It is written whole after every change and removed with
  the rest at every end of the session.
- **Replay.** One write at a time per account, in order, for the whole process, through the sender of a window
  (`QueueSender`, the window's `AuthenticatedApi` with the session signed in now): when a write is queued, when a
  window attaches, when the sync socket connects, when an answer ends the offline state, and after a failed attempt
  with a backoff from 1 s doubling to 60 s with jitter. Before a write is sent, every id the device made that the
  server answered is replaced by the server's id in its path, query and body; a write naming an id whose write was
  dropped is dropped too.
- **Outcomes.** Success removes the write and maps its id; no answer keeps it until the next trigger; a `5xx` or a
  `429` keeps it, counted, and drops it after 8; `401` stops the replay, and the window forgets the session and with it
  the queue; `404` of a `DELETE` counts as done; `409` of a `PATCH /api/items/:id` with `ifVersion` reads the item and
  sends the change once more with its current version; every other answer drops the write. A dropped write records a
  failure that names only its route, its `FailureKind` and the time. Every success and every drop makes the kept
  answers stale and tells every window. The layer publishes the number of waiting writes and the failures.
- **Shown in the answers.** Every answer of the offline set is returned with the writes still queued applied in
  queue order (`QueuedWriteProjection`); with nothing queued, or an answer that is not JSON, it is returned as it came.
  An item change sets its properties on every object of the item and on its timeline and agenda entries, with the
  completion and effective day the server derives for a task; a delete removes the item everywhere and its own read
  answers `404`; a create answers its own read, joins the first page of its database's queries whose filter it matches
  (only the filter nodes `ItemFilterMatch` knows; any other never matches, and a relative date compares with the
  device's day) and the timeline and agenda that hold its day; relations, stored occurrences and invitation answers
  show too. The device derives nothing more: a reminder whose item changed its time or alerts, was completed or was
  deleted is left out until the server sends it again, a repeating event or task created offline shows only its first
  day, and the overview, sleep and Inbox answers show the server's counts until the write reaches it.

## Consequences

- A change made without a connection succeeds on the device and reaches the server once and in order when the
  connection is back; with a connection and nothing queued a write behaves exactly as before.
- A change the server refuses after the device accepted it is dropped and recorded; the person learns of it only
  once the status is shown.
- Last writer wins for a change replayed against a newer version of an item: the device sends its change again on the
  item's current version.
- Ending the session drops what is still queued.
