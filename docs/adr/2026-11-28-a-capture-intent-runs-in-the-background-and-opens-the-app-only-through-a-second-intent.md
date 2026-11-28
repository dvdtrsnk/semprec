---
status: accepted
date: 2026-11-28
area: [mobile]
supersedes: []
superseded-by: null
---

# A capture intent runs in the background and opens the app only through a second intent

## Context

`AddToInboxIntent` captured a text in the background and, on iOS, a scan in the foreground
([[2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk]],
[[2026-11-27-the-document-scanner-is-the-one-uikit-view-controller-of-the-apple-app]]). To do both it declared
`supportedModes = [.background, .foreground(.dynamic)]`, asked for the content (text or scan) after the type, and
called `continueInForeground` for a scan.

In the owner's test of the Action button the Shortcuts app showed an "Open When Run" toggle on the action. The
toggle is the person's choice between the two modes the intent declares: the build's extracted
`Metadata.appintents/extract.actionsdata` recorded the intent with `supportedModes: 9` (background and the dynamic
foreground mode) and the system protocol `com.apple.link.systemProtocol.ForegroundContinuable`, while
`openAppWhenRun` was `false`. The owner wants no such choice: a text never opens the app, a scan always does, and one
pick from the list of types should open the scanner, without a second question.

The AppIntents interface of the iOS 27 SDK offers three ways to open the app from an intent: a foreground mode in
`supportedModes` (`.foreground(.immediate)`, `.foreground(.deferred)`, `.foreground(.dynamic)`), the deprecated
`openAppWhenRun` and `ForegroundContinuableIntent` (both replaced by `supportedModes` since iOS 26), and a result
that names another intent for the system to run next (`OpensIntent`, `.result(opensIntent:dialog:)`).

Rejected:

- Keeping one intent with both modes: the toggle is exactly what two modes produce.
- One foreground-only intent: every text capture would open the app.
- A content question after the type: the owner wants one pick.

## Decision

- **One mode per intent.** A system entry point of the Apple app declares one mode in `supportedModes`: `.background`
  for work that never needs a window, a foreground mode for work that always does. None declares both, so Shortcuts
  offers no "Open When Run" choice.
- **Opening the app is a second intent.** When a background intent decides that the rest of the work needs the app
  on screen, it answers with a result that opens a second intent (`.result(opensIntent:dialog:)`), declared
  `supportedModes = .foreground(.immediate)` and `isDiscoverable = false`, so it is not offered on its own and the
  system runs it with the app open. It does not call `continueInForeground`.
- **For the Inbox.** `AddToInboxIntent` is background only. Its type list starts with "Scan" where the device has the
  document scanner (never on a Mac), then "No type", then the server's types. A type or "No type" asks for the text and
  keeps it in the background. "Scan" answers with `ScanIntoInboxIntent`, which shows the scanner through the
  process's `ScanPresenter` and keeps the PDF app-side, without a type and without a text; it answers whether the
  scan was saved or cancelled.

This narrows [[2026-11-27-the-document-scanner-is-the-one-uikit-view-controller-of-the-apple-app]]: the intent's
content choice (`InboxContent`) and its `continueInForeground` are gone; the scanner, its presenter and the
app-side write are unchanged.

## Consequences

- The extracted metadata of the build records `AddToInboxIntent` with `supportedModes: 1` (background), no system
  protocols and `openAppWhenRun: false`, and `ScanIntoInboxIntent` with `supportedModes: 2` (foreground),
  `openAppWhenRun: true` and `isDiscoverable: false`. That the Shortcuts app then shows no toggle is the reading of
  these fields; it is confirmed only on a device.
- The background intent's result type carries a dialog in both branches, so handing over to the second intent says
  so in a short dialog of its own before the second intent's answer.
- A scan cannot carry a type or a text; adding either needs its own parameter on the second intent.
