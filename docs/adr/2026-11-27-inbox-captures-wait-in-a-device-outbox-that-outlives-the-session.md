---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# Inbox captures wait in a device outbox that outlives the session

## Context

[[2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection]] queues the writes of the offline set,
`POST /api/inbox/items` among them, in `<account>/queue.json` of the offline store. For an Inbox capture that queue
loses what the person captured in several ways:

- A capture with a file first uploads it with `POST /api/blobs`, which is not queued, so a capture with a file fails
  without a connection. Uploading early does not help: the server deletes standalone uploads that nothing references
  after 24 hours (`backend/packages/data/src/blobs/unreferencedBlobSweep.ts`).
- The queue drops a write after 8 server errors and after any refusal, and drops everything when the session ends
  (sign-out, or the `401` of a revoked token).
- Its account key hashes the token (`accountKey`), so it changes at every sign-in, and a queue of an earlier sign-in is
  never sent.

The owner captures into the Inbox from the iPhone's Action button, with text or a scanned document, often without a
connection, and wants nothing captured to be lost. The server already makes repeats harmless: `POST /api/inbox/items`
answers a repeated `Idempotency-Key` with the item it created, and `POST /api/blobs` stores bytes by their content hash.

Rejected: keeping captures in the write queue with exceptions for their route (no attempt limit, no drop on refusal,
surviving the end of the session). The queue is one file per account that the session's end removes, keyed by the
token, with one order across every write; carving captures out of each of its rules would leave a queue whose rules
depend on the route, and its account key would still change at every sign-in.

## Decision

This narrows [[2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection]] for Inbox captures:
`POST /api/inbox/items` is no longer a queued route (`QueuedRoute`), and every capture made on a device that keeps data
waits in a capture outbox (`CaptureOutbox` in `:shared:data`, owned by `OfflineLayer`, one per data directory and
process). Every other rule of the queue stays as that decision states. Without a data directory a capture is sent at
once, as before.

- **Storage.** Each capture is `<dataDirectory>/captures/<owner>/<captureId>.json` (the text, the day `YYYY-MM-DD`,
  the time `HH:mm`, the type id or none, the file's name, media type and source when it has one, the blob id and upload
  time once uploaded, the number of refusals, the time of the next attempt and the creation time) and, with a file,
  `<captureId>.bin` beside it. The bytes are written first, then the JSON; each is written beside its target and moved
  over it. A capture exists once its JSON exists; a `.bin` without its JSON is deleted when the outbox lists the
  directory. `captureId` is a random UUID and is the capture's `Idempotency-Key`. The directory is outside the
  `offline` directory of the store, so no rule of that store reaches it.
- **Owner.** `<owner>` is the hex SHA-1 of the server URL and the id of the person the offline store keeps for the
  session (`<account>/session.json`), not of the token, so it stays the same across sign-ins of that person. A capture
  made while no person is known is refused with a failure and nothing is written.
- **Lifetime.** Ending the session (`OfflineLayer.clear()`) and keeping one account's offline answers never delete
  `captures/`. A capture is deleted only after the server answered its `POST /api/inbox/items` with success. Nothing
  is ever dropped.
- **Sending.** One round at a time per process, for the owner of the session signed in now, through the window's
  sender (`QueueSender`, which also uploads raw bodies). A trigger while a round runs makes that round look at the
  directory once more. Captures go out in creation order, one at a time: the file (`POST /api/blobs`) unless an
  uploaded blob id is recorded, then `POST /api/inbox/items` with the body a direct capture sends and
  `Idempotency-Key: <captureId>`. No answer, a `5xx`, a `429` or a `401` ends the round and keeps the capture, with no
  limit on how often. A refusal of the item that names the type (`error.details.field` is `typeId`) is sent again at
  once without the type, and the capture is written without it. A refusal of the item that names the blob
  (`error.details.field` is `attachments`, or `error.details` has a `blobId`) is followed, once per delivery, by a new
  upload and a new send. Any other refusal of either request keeps the capture, counts it and does not try it again
  for 1 hour; the round goes on with the next capture. A capture whose file is missing and that was never uploaded is
  left as it is and goes on waiting.
- **Triggers.** A round starts when a capture is added, when an answer ends the offline state or a sync socket
  connects, when a window starts (`OfflineLayer.warmUpWith`), and after a round that ended without an answer, with a
  backoff from 1 s doubling to 60 s with jitter, for as long as the process runs. A round ended by a `5xx`, a `429` or
  a `401` waits for the next trigger.
- **After a success** the layer's change flow emits, so the open screens of every window read again.
- **Status.** The captures of the owner signed in count in `OfflineStatus.waiting`; with nobody signed in none count.

## Consequences

- A capture is never lost to a missing connection, a crash, a restart, a refusal or a sign-out; the person sees it
  counted among the changes that wait, but not which one, and cannot retry or edit a refused capture by hand.
- Unsent captures, their text and their files, stay on the device after the session ends, including after a sign-out
  that the person may expect to remove what the app keeps. They are sent the next time the same person signs in to the
  same server, and are never sent with another person's session.
- A capture the server keeps refusing is tried again every hour, at the next trigger after that hour, without end.
- A refused type is dropped rather than losing the capture: the item reaches the Inbox without the type the person
  picked.
- A `5xx`, `429` or `401` is not retried on a timer; the capture waits for the next trigger.
