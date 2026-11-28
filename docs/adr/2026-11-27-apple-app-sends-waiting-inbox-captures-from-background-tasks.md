---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# The Apple app sends waiting Inbox captures from background tasks

## Context

The device capture outbox ([[2026-11-27-inbox-captures-wait-in-a-device-outbox-that-outlives-the-session]]) sends
captures while the app's process runs. After an Action-button capture made offline
([[2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk]]) the system suspends the app, so the
capture waits until the person opens the app again. iOS offers `BGTaskScheduler`: a processing task with
`requiresNetworkConnectivity` runs once the device has a network, and an app refresh task runs when the system sees
fit. Neither time is guaranteed. macOS has no `BGTaskScheduler` for apps.

Rejected:

- A background `URLSession` upload. It would reach the server without the app's process, but its requests would be
  built and answered outside the shared data layer
  ([[2026-10-24-mobile-backend-calls-through-shared-data-layer]]): the Swift side would have to rebuild the outbox's
  upload, item request, idempotency key and refusal handling, and read and delete the outbox's files itself. It is
  rejected for now. It can be reconsidered if the tasks below prove too rare in practice.
- Silent pushes that wake the app to send. The server cannot know that a device holds a capture it never received.
- SwiftUI's `.backgroundTask(.appRefresh(_:))` scene modifier for the refresh task. SwiftUI has no matching modifier
  for a processing task, which needs `BGTaskScheduler.register` anyway. Registering both the same way keeps one launch
  path, one expiration handling and one completion rule for both tasks.

## Decision

- **Two tasks, one send.** On iOS the app registers a processing task `cz.semprec.app.inboxCaptures.send`
  (`requiresNetworkConnectivity = true`) and an app refresh task `cz.semprec.app.inboxCaptures.refresh`, both listed in
  `BGTaskSchedulerPermittedIdentifiers`, with the `fetch` and `processing` background modes. The identifiers start with
  the app's bundle id `cz.semprec.app`. Apple does not require that prefix, but it keeps the names clear of other
  apps'. Both tasks run the same thing: `InboxCaptureSDK.send()` through the CoreKit bridge `InboxShortcutCapture`, the
  headless entry of the system entry points. No Swift code sends a capture itself.
- **Where they are registered.** In `AppDelegate.application(_:didFinishLaunchingWithOptions:)`, the iOS app delegate
  that already exists for remote notifications. The system requires registration before the app finishes launching.
  The handlers run on the main queue.
- **How a run ends.** A run completes its task exactly once. When the send returns, the run asks whether a capture of
  the person signed in still waits (`InboxCaptureSDK.capturesWait()`, a count on the device, which answers waiting,
  nothing or unknown when the count failed). With nothing waiting it completes with success. With some waiting, or
  when that is unknown, it schedules both tasks again and completes without success. When the
  system expires the task first, the run cancels the send's Swift task, schedules both tasks again (the send did not
  finish), and completes without success. Cancelling the send cancels the outbox's round when no other trigger
  waits for it (a capture just added, a window, a retry after a backoff each wait for the round they started), so an
  expired task leaves no request of its own running while the system suspends the app. Nothing is lost: a capture is
  deleted only after the server created its item, and one sent again carries the same `Idempotency-Key`.
- **When they are scheduled.** Both are scheduled together, and only while captures wait or the count failed: after a
  capture is added by the intent (before its brief send, so they are submitted even when the system suspends the app
  during it), by the scanner (once the scan's capture is kept), or by the diary's capture row, and when the app moves to
  the background. A new request replaces the pending one with the same identifier. A refused submission is not retried;
  the next trigger schedules again.
- **Sending when active.** When the app as a whole becomes active (`scenePhase` of `SemprecApp`), it runs one send
  through the bridge, on iOS and macOS; while the send of an earlier activation still runs, it starts none. On macOS
  this is the only part that applies, and the BackgroundTasks code is compiled only for iOS (`#if os(iOS)`).
- **One owner.** `CaptureSending` (one per process, in the app target) owns all of this. The app delegate, the app's
  phase, the intent, the scanner presenter and the diary report to it. A feature never imports BackgroundTasks. The
  Journal feature gets an `onCaptured` closure from the app through `JournalScreenFactory.journal`, and its capture
  ViewModel calls it for each `captured` effect. This is a plain closure, not a router method, because it is not
  navigation ([[2026-10-24-app-owned-mobile-navigation-through-feature-routers]] keeps routers for navigation).
- **One bridge per process.** The background tasks, the send on activation and the diary hook use the bridge of the
  intents, `InboxShortcutCapture.shared`
  ([[2026-11-27-apple-system-entry-points-run-in-the-app-over-a-headless-sdk]]), so none of them adds a Kotlin SDK or
  an HTTP client of its own.

## Consequences

- An offline capture can reach the Inbox without the app being opened, once the system runs one of the tasks. It may
  still wait for hours, because the system decides when the tasks run. A background run without a window sends through
  the headless sender, whose `401` ends no session, as the headless SDK ADR records.
- A capture that can never be sent (a JSON file the outbox cannot read, which it still counts) keeps both tasks
  scheduled for as long as it stays. The system limits how often the tasks run.
- An expired run, or an expiration that arrives after the run completed, schedules once more even when nothing waits,
  and so does an intent's capture that reaches the server during its brief send. The extra run then finds nothing to
  send and completes with success.
- `InboxCaptureSDK` exports `capturesWait()`, so Swift can ask whether captures wait without reading the outbox's
  files. A count that fails answers unknown rather than nothing waiting, so a failure schedules the tasks instead of
  leaving a capture without them.
- A later Swift entry point that adds a capture reports it to `CaptureSending.captureAdded()`. A capture added by
  Kotlin alone (another screen's capture through the shared ViewModel) is covered by the move to the background.
