---
status: accepted
date: 2026-11-23
area: [mobile]
supersedes: [2026-11-23-mobile-keeps-the-answers-of-the-offline-set]
superseded-by: null
---

# The mobile apps answer from the device at once and read the server again behind the answer

## Context

[[2026-11-23-mobile-keeps-the-answers-of-the-offline-set]] keeps the answers of the offline set on the device. It
answers a kept answer at once only while it is fresh (kept by this process after the last change signal, less than
five minutes ago) or while the process is offline; answers read from disk after a restart are not fresh, so every
screen of a cold start waited for the server, and the app opened on a spinner on every launch. The restore of the
session did the same: it waited for the server's answer before it showed anything, and used the person kept for the
session only when no answer came. The owner asked for the app to open instantly, from what the device keeps, and to
bring the newest data in behind it.

The change signals of that decision exist for consistency: after a write of this window, a reconnect or a frame of the
sync socket, a kept answer may show what is no longer true. After a write of its own a screen that reads again expects
to show that write; after a change on the server nothing on the screen was changed by the person, and the frames of a
busy account (a mailbox that syncs) came often enough that almost every read waited for the server.

## Decision

This replaces [[2026-11-23-mobile-keeps-the-answers-of-the-offline-set]]: its rules on where answers are kept, what is
kept, how and for whom, and how the device warms up stand as restated below; how a kept answer is given (*fresh*,
*stale and missing*) and how the app opens are changed.

- **Where.** `AuthenticatedApi` hands every read of the offline set to `OfflineLayer` in `:shared:data`, which answers
  it from the device or from the server. The repositories build the same requests and decode the same answers as
  before; none of them decides anything about offline use. Every other request goes to the server, and the layer only
  learns from its outcome whether the server was reached and whether a write may have changed what it keeps.
- **The offline set** is the `GET` of `/api/schema`, `/api/databases`, `/api/items/:id`, `/api/items/:id/related`,
  `/api/items/:id/page`, `/api/calendar/timeline`, `/api/calendar/agenda`, `/api/calendar/reminders`,
  `/api/badge-counts`, `/api/journal/periods/:type/:period`, `/api/overview`, `/api/sleep/nights`,
  `/api/inbox/cards`, `/api/inbox/cards/count` and `/api/inbox-types`, and the `POST` of `/api/databases/:id/query`
  and `/api/databases/:id/facets` (`OfflineRoutes`). A request is kept under its method, its path, its query in the
  order sent and its body.
- **Storage.** `OfflineStore` writes JSON files through `CacheFiles` under `<dataDirectory>/offline/<account>/answers/`,
  where `dataDirectory` is a directory the system does not empty, handed to `HomeSDK(dataDirectory:)` (the Apple app
  passes `Application Support/Offline`, excluded from backups; `null` keeps nothing). The account directory is named by
  `accountKey`; keeping for one account removes every other account's, and every end of the session removes
  everything and drops any answer that arrives late for the session that ended. One file per answer, named by a
  64-bit FNV-1a hash of its key and repeating the key, the account and a version (a file that does not match reads as
  nothing and is deleted), and an index most recently kept first: at most 500 answers, and an answer over 1 MiB is not
  kept, so the one before it stays. An answer kept again unchanged is not written again; only its place in the index
  moves.
- **Sharing.** Every window of the process that names the same directory shares one layer
  (`OfflineLayer.shared(directory)`): one store, one freshness and one offline state, the store taking one lock for
  each call. The layer's background work runs in a scope of its own for as long as the process.
- **Two kinds of change signal.** A *write* is a request a window announces that succeeded, a queued write that
  reached the server or was dropped, and the saving of a page's text. A *change on the server* is the sync socket
  connecting, every text frame it receives, and an answer that ends the offline state. Both make every kept answer
  stale.
- **Fresh answers.** A kept answer is fresh when this process kept it after the last change signal and less than
  5 minutes ago; a fresh answer is returned without a request.
- **At once, read again behind.** A kept answer that is not fresh is returned at once when no write went to the server
  after its request went out: when this process has not kept it (it was read from disk after a start), or when only
  time or a change on the server made it stale. Its request then goes out in the layer's background scope, at most one
  at a time per answer, and its outcome is settled as any other read's (below).
- **Telling the windows.** When an answer read again behind differs from the one given (another body, or `404`), the
  layer's change flow emits, once for every answer that arrives within 150 ms of the first, so a start that reads many
  answers again does not reload every screen for each of them. This emission makes nothing kept stale: the screens
  that read again find the new answers fresh.
- **Writes still wait, and missing answers go out.** A kept answer asked for before a write of this process, and a
  request with nothing kept, go to the server and wait for it: a success is kept and returned, `404` removes the kept
  answer, and a request that got no answer, a `5xx` or a `429` returns the kept answer when there is one, else the
  failure. Every other answer is returned as it came.
- **An item without an answer of its own.** An item's own read (`GET /api/items/:id`) that gets no answer, a `5xx` or
  a `429` and has no kept answer of its own returns the newest copy of the item that another kept answer holds with
  its `databaseId`, without the relations and links that list did not ask for.
- **Offline.** A request that got no answer makes the process offline until a request gets one or a socket connects.
  Offline, a read with a kept answer returns it at once, and at most once every 15 s one such read goes out in the
  background to check the connection. When an answer other than a window's own write ends the offline state, every
  kept answer turns stale and the layer's change flow emits.
- **Opening at once.** The person the server last confirmed for the session (a restore it answered, a sign-in) is kept
  in `<account>/session.json`. A restore with a person kept reports the session signed in as that person before its
  request goes out; the server's answer then decides: a session it confirms replaces it (with the person it names),
  a refusal (`401` or any other `4xx` but `429`) signs out, and an answer that is no session, no answer, a `5xx` or a
  `429` leaves the app open as it is. Without a kept person the restore waits for the answer, and one that does not
  come leaves the session unreachable.
- **Warm-up.** Every window registers an `OfflineWarmup` with the layer, which reads the offline set ahead of the
  screens with the requests those screens send: the schema and the databases, the task lists of every scope, the
  areas, projects and people, the calendars and invitations, the calendar windows of the current month, the one
  before and the two after, the agenda's first page from today, the diary's days from 7 back to 7 ahead with their
  pages, the overview, tonight's sleep, and the Inbox cards and types. A warm-up is due when a window starts, when an
  answer ends the offline state and when a sync socket connects; it runs once the queue replay that follows has
  finished, at most once every 30 minutes per account for the process, never offline and never without a session.
- **Reads together.** The overview and the calendar's window send their reads together rather than one after
  another; the first failure, in the order the screen names them, is the answer.
- **No server change.** The server keeps no replay buffer and no change feed: a device that was offline reads again,
  and the socket's frames only mark what is kept as stale.

## Consequences

- A cold start opens on what the device kept, without a spinner, and so does a screen after a change on the server;
  what the server answers differently replaces it a moment later. A screen opened for the first time in a process can
  show, for that moment, an answer kept before a write made earlier in the same process, when it had not read that
  answer since.
- A session that the server ended while the device was away opens for a moment and then signs out.
- A screen reads each answer it uses once more in the background, where it used to wait for the same request; nothing
  more goes to the server than before, only without the screens waiting for it.
