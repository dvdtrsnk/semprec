---
status: accepted
date: 2026-11-27
area: [mobile]
supersedes: []
superseded-by: null
---

# Apple system entry points run in the app over a headless SDK

## Context

The owner wants to capture into the Inbox from the iPhone's Action button, which runs an App Shortcut, without the
app's window. The system runs an App Intent while no scene exists, in the background, and may run it while a window
of the app is open. Until now Kotlin was reached only through a window's `SharedScreenModelFactory` and its
`HomeSDK` (one per scene), and through `SharedDeviceNotifications` over `DevicePushSDK` (one per process).

A `HomeSDK` is a window: its construction registers the window's warm-up of the offline set
([[2026-11-23-mobile-answers-from-the-device-at-once-and-reads-again-behind]]), it owns the window's sync socket
([[2026-11-20-mobile-screens-follow-the-sync-socket]]) and its `401` ends the session
([[2026-11-15-mobile-http-client-is-ktor-and-the-session-lives-in-the-keychain]]). An intent needs none of that, and a
background warm-up or socket would spend the few seconds the system gives it on reads nobody sees.

Rejected:

- An app extension (an App Intents extension) holding the intents. It runs in its own process, so it would share
  neither the Keychain session (without a keychain access group) nor `Application Support/Offline` (without an app
  group), and it would write the capture outbox from a second process, which the outbox does not coordinate
  ([[2026-11-27-inbox-captures-wait-in-a-device-outbox-that-outlives-the-session]] keeps one lock per process).
- Building a `HomeSDK` in the intent. It would start the warm-up, end the session on a `401` while the person is not
  looking at the app, and load the whole composition root for one call.
- Intents in CoreKit importing `SharedSDK` types into their parameters. App Shortcuts must be declared in the app
  target, and CoreKit is a library whose types the app's intents only consume.

## Decision

- **Where.** The system entry points of the Apple app, App Intents and the App Shortcuts that offer them, are declared
  in the app target (`mobile/apple/Projects/App/Sources/Intents/`) and run in the app's process. They share the
  Keychain session (`KeychainSessionStorage`) and the data directory `Application Support/Offline` with the windows,
  and so the process's `OfflineLayer` of that directory.
- **How they reach Kotlin.** Only through a CoreKit bridge (`@MainActor`, Swift values and `Failed`/`FailureKind` in
  its signatures) over a headless SDK entry of `:shared:umbrella` that needs no scene: `InboxCaptureSDK` for the Inbox
  captures. An intent never sees a Kotlin type, as no other app code does
  ([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]).
- **What a headless SDK does not do.** It builds an `AuthenticatedApi` over the process's `OfflineLayer`, so reads of
  the offline set answer from what the device keeps, but it registers no warm-up (`OfflineLayer.warmUpWith`), opens
  no sync socket and holds no screen ViewModel. Its `401` does not end the session: the next window's own calls meet
  the same refusal and end it there, where the person sees the sign-in.
- **The layer's sender stays a window's.** The layer's rounds (the write queue's replays, the note pages and the
  capture outbox) go through one sender. A headless SDK attaches its api's sender only when none is attached yet
  (`AuthenticatedApi(takesOverSender = false)`), so a window's sender, whose `401` signs that window out, stays in
  charge whenever one exists; a window created later replaces the headless one, as every window replaces the sender
  before it.
- **Lifetime.** The app holds one bridge per process, `InboxShortcutCapture.shared`, for every intent run, entity
  query and the other headless callers of the Inbox captures
  ([[2026-11-27-apple-app-sends-waiting-inbox-captures-from-background-tasks]]), so the process holds exactly one
  `InboxCaptureSDK` and one HTTP client for them: every `InboxCaptureSDK` builds its own `ApiClient`, whose Ktor client
  is never closed, so a bridge per call would add a client on every run. Holding it changes neither rule about the
  sender above. Its initializer over a session store and a directory stays internal for CoreKitTests.

## Consequences

- An intent works offline whenever a window has kept the answers it reads; with nothing kept it gets the failure of
  the read, and has to offer what it can without it (the type query offers only "Scan", where the device can scan, and
  "No type").
- In a process without a window the headless sender carries the layer's rounds, and a `401` of one of them does not
  end the session; the next window's own call does. With a window open, an intent changes nothing about who sends.
- A later system entry point (another intent, a control) follows the same shape: its own headless SDK entry and CoreKit
  bridge, never a `HomeSDK`. One that must run outside the app's process (a widget or control extension) needs a new
  decision about sharing the session and the outbox between processes.
