---
status: accepted
date: 2026-10-24
area: [mobile]
supersedes: [2026-09-10-single-networking-layer-in-apple-client]
superseded-by: null
---

# Every backend call of the mobile apps goes through the shared Kotlin data layer

## Context

[[2026-09-10-single-networking-layer-in-apple-client]] required one networking/API layer in the
Apple client, so that no SwiftUI view or view model opened its own `URLSession` request: one place
to change authentication, retries and error handling for every backend call. It assumed a Swift
client.

The mobile logic now lives in Kotlin Multiplatform below two native apps
([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]). A Swift networking layer in the
Apple app and a Kotlin one in the Android app would each build requests, attach authentication,
decide which failures are expected and map them for the screens, and the two would drift. Calls
made from native code would also put that decision outside the shared ViewModels that turn
failures into screen state.

No mobile code calls the backend yet. `:shared:data` has one repository,
`InMemoryPlaceholderRepository`, which never fails. The Android manifest declares no `INTERNET`
permission, and the macOS app's entitlements
(`mobile/apple/Projects/App/Entitlements/Semprec.entitlements`) enable the App Sandbox without
`com.apple.security.network.client`, so neither the Android app nor the macOS app can open a
network connection today.

## Decision

Every call a mobile app makes to the Semprec backend is made by Kotlin code in
`mobile/shared/data`, implementing a port that `mobile/shared/domain` declares (as
`InMemoryPlaceholderRepository` implements `PlaceholderRepository` today). Screens reach it only
through use cases and shared ViewModels. Expected failures cross the port as typed values
(`RepositoryResult.Failure` with a `FailureKind`); cancellation propagates.

No other mobile code talks to the backend, and none of it uses `URLSession`, OkHttp,
`HttpURLConnection` or Ktor for that: not an Android feature or app module, not a SwiftUI view, a
feature `*ViewModel`, CoreKit or the Apple app, and not a shared ViewModel in
`mobile/shared/presentation`, which never depends on `:shared:data`.

The native login that `mobile/apple/docs/auth-bridge.md` (issue #141) describes is such a call.
The web editor that the same document has the Apple app embed in a `WKWebView` makes its own API
calls, through the web client's operations adapters
([[2026-09-29-web-client-calls-the-api-through-operations-adapters]]); those are calls of the web
code and this decision does not cover them.

The HTTP client library and the wire format are chosen by the issue that adds the first backend
call, not here ([[2026-09-10-no-speculative-generality-beyond-issue-scope]]).

## Consequences

- Authentication, retries and error mapping for a backend operation change in one place for both
  apps, and are tested in `commonTest` on the JVM and the native targets.
- A screen that needs backend data needs a shared use case and ViewModel for it first; there is
  no shortcut of a native request for one screen.
- The issue that adds the first backend call also adds the Android `INTERNET` permission and the
  macOS `com.apple.security.network.client` entitlement.
