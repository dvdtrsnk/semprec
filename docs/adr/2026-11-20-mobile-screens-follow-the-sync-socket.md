---
status: accepted
date: 2026-11-20
area: [mobile]
supersedes: []
superseded-by: null
---

# Mobile screens follow the sync socket

## Context

The open screens of a window reload after any write of that window
(`2026-11-16-open-mobile-screens-reload-after-any-write-of-their-window.md`), but a change made elsewhere (another
device, Semp, a remote calendar the server syncs, a mailbox the server imports) showed only on the next reload. The
mail account screens polled every 10 s while an account synced. The server already publishes thin frames on
`WS /api/sync` (`docs/architecture/data-model-and-writes.md`), which the web client follows.

## Decision

- Each window has one sync socket, `SyncSocket` in `:shared:data`, on the window's `AuthenticatedApi`: it goes out to
  the stored server with the stored bearer token, as every request does, and a close with 4401 (session revoked)
  signs the window out, as a `401` does. Its wire handling mirrors the web client (`@semprec/realtime-client`): the
  same frame checks for the frames it keeps, the same reconnect backoff (1 s floor, ceiling doubling to 30 s,
  jittered), and one "read everything again" after every successful connect, because the server does not replay
  what it published while the socket was away. The server's heartbeat pings are answered by the engines (URLSession,
  OkHttp).
- Frames become revisions of a change bus, `SyncChanges` in `:shared:domain`, with one topic per kind of data a
  screen shows (`SyncTopic`): `item` and `relation` frames by the canonical key of their database (from
  `GET /api/schema`, read on each connect), `notification` frames by their kind. Frames that arrive within 300 ms
  raise their topics once. A ViewModel that shows such data takes its topic's changes and reloads quietly, unless its
  own read or write is under way; the calendar, the calendars sheet, the invitations and the three mailbox screens do,
  and the mailbox screens no longer poll.
- The native owner of the window starts the socket when the window shows its signed-in tabs and comes to the
  foreground, and stops it when the window goes to the background or stops showing its tabs. On Apple, the scene's
  `scenePhase` drives `ScreenModelFactory.startLiveUpdates()` and `stopLiveUpdates()`, which CoreKit forwards to
  `HomeSDK.sync`.

## Consequences

- A change the server applies, by anyone, reaches an open calendar, invitations list or mailbox screen as soon as its
  frame arrives (gathered for 300 ms), without polling; a screen that missed frames while the window was in the
  background reads everything again when the window comes back.
- Another screen that should follow server changes adds a topic, the database keys or notification kinds that raise
  it, and takes its changes in its ViewModel.
- A window in the background is not told about changes; the reconnect on foreground is what brings it up to date.
- The client sends no pings of its own: a connection that dies without the engine reporting it stays silent until
  the window next comes back from the background, which starts a new socket.
- The Android app has no sign-in and none of these screens, so it starts no socket; its `HomeSDK` would connect
  nothing without a session anyway.
