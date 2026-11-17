---
status: accepted
date: 2026-11-16
area: [mobile]
supersedes: []
superseded-by: null
---

# Open mobile screens reload after any write of their window

## Context

A person adds a task in the Tasks screen, deletes an item in its sheet or files an Inbox card, and expects every
screen that shows the same data to show the change at once: the counts of the overview, the calendar, the area, the
collection under the sheet. Before this decision only one path did so: the Podrobnosti sheet announced its own
writes through `ItemChanges` and only the Tasks screen listened. Every other list showed what it had loaded until it
was pulled to refresh or opened again.

Writes are spread over dozens of repositories and screens, and every new screen adds more. Announcing each write at
its call site, and listening at each list for the writes that concern it, is a contract every future change would
have to remember, and missing one is invisible until a person reports stale data.

The server's realtime fan-out (`docs/adr/2026-10-16-tenant-scoped-realtime-fan-out.md`) would also report changes
made elsewhere (Semp, another device), but the mobile apps do not connect to it yet.

## Decision

- `AuthenticatedApi`, through which every signed-in request of a window goes, owns that window's `ItemChanges`. It
  announces a change after every successful request that is not a `GET`, except the requests that only read with a
  `POST` body: a path ending in `/query` or `/count`, a path under `/api/search`, and the raw staging of a blob
  (`/api/blobs`), whose item is created by a later request that announces itself.
- A screen ViewModel that shows server data takes the window's change events and, on each one, runs the reload its
  own `Refresh` (or, without one, its load) already performs: quietly, keeping what is on screen until the answer
  replaces it. A screen that is in the middle of its own write or gesture (the calendar while dragging or saving)
  keeps the rules its `Refresh` already has.
- The signal carries no detail of what changed. A screen reloads what it shows; deciding per screen which writes
  concern it is not attempted.

## Consequences

- A write in any screen, including one added later, reaches every open screen of the same window without code at the
  write site. A new list screen has to take the change events in its ViewModel to stay current.
- One write causes one quiet reload per open screen, the screens under the top of a stack included. That is a few
  extra reads per write, accepted for correctness.
- A write made by the screen itself is followed by its own reload as well; screens whose loads replace the previous
  one keep that harmless.
- Changes made outside the app (Semp in the background, another device) are still seen only on the next reload. The
  realtime connection is a later decision.
