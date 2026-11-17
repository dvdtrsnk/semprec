---
status: accepted
date: 2026-11-15
area: [mobile]
supersedes: []
superseded-by: null
---

# The mobile HTTP client is Ktor over JSON, and the session token lives in the platform's secure store

## Context

[[2026-10-24-mobile-backend-calls-through-shared-data-layer]] puts every backend call in
`mobile/shared/data` and leaves the HTTP client and the wire format to the issue that adds the first call.
This is that decision. The backend already authenticates native apps: `POST /api/auth/login` with
`platform: "ios"` or `"macos"` answers `{ token, user }`, and every later request carries the token as
`Authorization: Bearer` (`mobile/apple/docs/auth-bridge.md`). The same token has to reach the embedded web
editor through a `WKWebView` message handler that only Swift can serve, so native Swift code must be able to
read it even though Kotlin makes the calls.

## Decision

- The client is Ktor 3 (`ktor-client-core`) with the Darwin engine on Apple and OkHttp on JVM and Android,
  declared per source set in `:shared:data`. Bodies are JSON strings handled with kotlinx.serialization:
  requests are encoded and responses decoded by `ApiJson` (unknown fields ignored, nulls omitted), so the
  server may add fields without breaking an installed app. No Ktor type appears in a signature that
  `:shared:umbrella` or `:shared:presentation` uses.
- `ApiClient` is the only class that opens a connection. It maps a status or a transport problem to a
  `FailureKind` and rethrows cancellation: 401 and 403 are `UNAUTHORIZED`, 404 `NOT_FOUND`, 400, 409 and 422
  `REJECTED`, 429 and 5xx and a failed connection `UNAVAILABLE`, any other status `INVALID_DATA`. A body that does
  not decode is `INVALID_DATA`.
- The token and the server address are a `StoredSession` kept through the `SessionStorage` port in `:shared:core`,
  which the native app implements. On Apple that is `KeychainSessionStorage` in CoreKit (`Security` is added to
  the allowed system modules for it); the token is stored nowhere else. When the Keychain refuses an item, as it
  does for an unsigned build, the session is held in memory for the life of the process. Android supplies its own
  implementation when it adopts the session; until then `InMemorySessionStorage` is the default.
- A `401` on an authenticated call means the server no longer knows the session: `AuthenticatedApi` forgets the
  session, which signs the device out.

## Consequences

- Every feature repository in `:shared:data` takes an `AuthenticatedApi` and never builds a URL or a header itself.
- The macOS app needs `com.apple.security.network.client` and the Android app `INTERNET` when each ships a screen
  that reads data; this ADR adds neither, because no platform permission is needed by the JVM and native tests.
- A person who is offline at launch keeps the token: the session status is `Unreachable`, not signed out.
- Anything that needs the token outside Kotlin (the web editor bridge) reads it from the same `SessionStorage`.
