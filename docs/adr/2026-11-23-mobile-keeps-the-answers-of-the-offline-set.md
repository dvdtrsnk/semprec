---
status: superseded
date: 2026-11-23
area: [mobile]
supersedes: []
superseded-by: 2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind
---

# The mobile apps keep the answers of the offline set and serve them without a connection

## Context

Every screen of the mobile apps read the server each time it opened: it waited on every open, and without a
connection it showed nothing. The owner asked for the apps to keep their data on the device, to be fast because they
read that copy, to work without a connection, and to keep following the server's live changes. Mail, files,
recordings, transcripts, search and Semp stay online only; everything else the screens show (tasks, events, calendars,
invitations, projects, areas, people, companies and the other collections, the diary, the overview, sleep, the Inbox,
the reminders the device schedules) is the *offline set*.

[[2026-11-22-mobile-keeps-mail-thread-lists-in-a-file-cache]] already keeps the mail thread lists as JSON files
through the `expect` functions of `CacheFiles.kt`, in a cache directory, one directory per account, emptied at every
end of the session. Every signed-in request of a window goes through `AuthenticatedApi.send`
([[2026-10-24-mobile-backend-calls-through-shared-data-layer]],
[[2026-11-16-open-mobile-screens-reload-after-any-write-of-their-window]]), and the window's sync socket reports the
server's changes and reads everything again after each connect ([[2026-11-20-mobile-screens-follow-the-sync-socket]]).

Rejected: a sync library. PowerSync, the one complete Kotlin Multiplatform sync engine, replicates Postgres through
logical replication, which bypasses the row-level security that isolates tenants, and needs another service and a
Postgres restart; Realm's device sync ended in September 2025; Couchbase Lite and Ditto need their own servers;
ElectricSQL has no mobile write path; Store5 caches reads only. Rejected too: replicating rows into a local database.
The screens read server read models (the calendar timeline, the agenda, the overview, the diary period) whose
derivations (recurrence, sleep, birthdays, rollups) would have to be implemented a second time on the device, and a
row change feed would be a new server protocol where the realtime decisions keep the server free of replay.

## Decision

- **Where.** `AuthenticatedApi` hands every read of the offline set to `OfflineLayer` in `:shared:data`, which answers
  it from the device or from the server. The repositories build the same requests and decode the same answers as
  before; none of them decides anything about offline use. Every other request goes to the server as before, and the
  layer only learns from its outcome whether the server was reached and whether a write may have changed what it
  keeps.
- **The offline set** is the `GET` of `/api/schema`, `/api/databases`, `/api/items/:id`, `/api/items/:id/related`,
  `/api/items/:id/page`, `/api/calendar/timeline`, `/api/calendar/agenda`, `/api/calendar/reminders`,
  `/api/badge-counts`, `/api/journal/periods/:type/:period`, `/api/overview`, `/api/sleep/nights`,
  `/api/inbox/cards`, `/api/inbox/cards/count` and `/api/inbox-types`, and the `POST` of `/api/databases/:id/query`
  and `/api/databases/:id/facets` (`OfflineRoutes`). A request is kept under its method, its path, its query in the
  order sent and its body.
- **Storage.** `OfflineStore` writes JSON files through `CacheFiles` under `<dataDirectory>/offline/<account>/answers/`,
  where `dataDirectory` is a directory the system does not empty, handed to `HomeSDK(dataDirectory:)`: the Apple app
  passes `Application Support/Offline`, excluded from backups, and `nil` for its in-memory test store; Android passes
  nothing, and `null` keeps nothing. Unlike the mail lists, the offline set is what the app shows without a connection,
  so it must not live where the system purges it. The account directory is named by `accountKey` as for the mail
  lists; keeping for one account removes every other account's, and every end of the session (the `sessionEnded`
  hook) removes everything and drops any answer that arrives late for the session that ended. One file per answer,
  named by a 64-bit FNV-1a hash of its key and repeating the key, the account and a version (a file that does not
  match reads as nothing and is deleted), and an index most recently kept first: at most 500 answers, and an answer
  over 1 MiB is not kept, so the one before it stays. No database library: the store needs answers by key and no
  queries, which [[2026-11-22-mobile-keeps-mail-thread-lists-in-a-file-cache]] reserved for a decision of its own.
- **Sharing.** Every window of the process that names the same directory shares one layer
  (`OfflineLayer.shared(directory)`), so they share one store, one freshness and one offline state, and the store takes
  one lock for each call. The layer's background work runs in a scope of its own for as long as the process.
- **Fresh answers.** A kept answer is fresh when this process kept it after the last change signal and less than
  5 minutes ago; a fresh answer is returned without a request. The change signals are a successful request that is
  not a read (the requests `AuthenticatedApi.announces`, and the saving of a page's text, which the diary's period
  answer shows), the sync socket connecting, and every text frame it receives. An answer whose request went out before
  a change signal is born stale, and answers read from disk after a restart are not fresh.
- **Stale and missing answers.** Otherwise the request goes out: a success is kept and returned, `404` removes the
  kept answer, and a request that got no answer, a `5xx` or a `429` returns the kept answer when there is one, else the
  failure. Every other answer is returned as it came.
- **An item without an answer of its own.** An item's own read (`GET /api/items/:id`) that gets no answer, a `5xx` or
  a `429` and has no kept answer of its own returns the newest copy of the item that another kept answer holds with
  its `databaseId` (a row of a list, most recently used or kept first), without the relations and links that list did
  not ask for. The screens list most items long before they open one, and the item repository reads an item back
  after each change it writes to it: without the copy, an item seen only in a list could not be opened offline, and a
  change made to it offline, though queued, would report that it failed.
- **Offline.** A request that got no answer makes the process offline until a request gets one or a socket connects.
  Offline, a read with a kept answer returns it at once, and at most once every 15 s one such read goes out in the
  background to check the connection. When an answer other than a window's own write ends the offline state, every
  kept answer turns stale and the layer's change flow emits; each window's `ItemChanges` merges that flow with its own
  announcements, so the open screens of every window read again.
- **Opening without a connection.** The person the server last confirmed for the session (a restore it answered, a
  sign-in) is kept in `<account>/session.json`. A restore that gets no answer, a `5xx` or a `429` opens the app signed
  in as that person, and stays unreachable as before when none is kept; every other answer is handled as before, a
  `401` signing the window out.
- **Warm-up.** Every window registers an `OfflineWarmup` with the layer, which reads the offline set ahead of the
  screens with the requests those screens send, through repositories over the window's `AuthenticatedApi`: the schema
  and the databases, the task lists of every scope, the areas, projects and people, the calendars and invitations,
  the calendar windows of the current month, the one before and the two after, the agenda's first page from today,
  the diary's days from 7 back to 7 ahead with their pages, the overview, tonight's sleep, and the Inbox cards and
  types; today is the device's day, as the screens are given it. A warm-up is due when a window starts, when an answer
  ends the offline state and when a sync socket connects, and it runs once the queue replay that follows has finished,
  so it reads what the replay wrote. It runs the warm-up of the window registered last, at most once every 30 minutes
  per account for the process, never offline and never without a session; it stops once the process turns offline,
  and a read that fails is left as it is.
- **No server change.** The server keeps no replay buffer and no change feed: a device that was offline reads again,
  which [[2026-10-16-tenant-scoped-realtime-fan-out]] already prescribes for a reconnecting client, and the socket's
  frames only mark what is kept as stale.

## Consequences

- A screen of the offline set opens at once from the device when nothing changed since it was last read, and without
  a connection it opens with what was kept; reads after a write, a reconnect or a frame go to the server as before.
- A read the device neither kept nor warmed fails without a connection as it did: a collection other than tasks,
  areas, projects and people is kept once opened. Writing offline, and showing the offline state, are
  [[2026-11-23-mobile-writes-wait-in-an-ordered-queue-without-a-connection]].
- A warm-up sends about forty requests to the server, each distinct request once; the reads it repeats (the schema,
  the databases) are answered from the device.
- The device holds a copy of the person's data outside the Keychain, protected by the system's file protection and
  removed at every end of the session; it holds no token, because the account is named by a hash.
- Requests outside the offline set behave exactly as before, and without a data directory nothing changes at all.
