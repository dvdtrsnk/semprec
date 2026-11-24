---
status: accepted
date: 2026-11-24
area: [mobile]
supersedes: []
superseded-by: null
---

# The Apple app makes the screen models of its Calendar and Journal tabs ahead of the tabs

## Context

A screen calls its `makeModel` once, when SwiftUI creates its `@StateObject`, and owns the model for as long as
SwiftUI keeps the screen. A `TabView` builds a tab's content only when the person first opens the tab, so the
calendar and the diary started to read their period only then: the first open of each tab waited for that read, even
with the answers kept on the device ([[2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind]]).
The owner asked for the tabs to open instantly.

## Decision

- `AppComposition` holds `PreparedTabModels`, which makes the Calendar's and the Journal's screen model for the
  device's current day shortly (300 ms) after the signed-in scene first appears, so the first tab is on screen before
  anything else is read.
- The tabs' roots pass `makeModel` closures that take the prepared model: it is handed out once, to the screen that asks
  for the day it was made for, and the screen owns it from then on exactly as if it had made it. A screen that asks for
  another day (the day changed meanwhile) gets a new model; the prepared one is dropped, which closes it.
- Only tab roots are prepared: they are the screens every session opens, and they have no input but the day. Screens
  pushed onto a stack keep making their model when they are created.

## Consequences

- The Calendar and the Journal open on their content, read while the person looked at the first tab.
- Both models read and follow the sync socket from the start of a session even when their tab is never opened, which
  costs their reads (answered from the device at once) and the memory of two screen states.
- A prepared model lives in the composition until its tab takes it, so it ends with the scene like every other model
  of the scene.
