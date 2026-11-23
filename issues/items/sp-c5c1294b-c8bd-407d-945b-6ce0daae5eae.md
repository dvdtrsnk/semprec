---
schemaVersion: 1
id: "sp-c5c1294b-c8bd-407d-945b-6ce0daae5eae"
title: "[offline-first 02/07] Open the signed-in app without a connection"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["spec:approved"]
parent: "sp-77a3392a-3026-414c-8dd4-c6ad627e5168"
assignees: []
milestone: null
createdAt: "2026-11-23T07:06:27.589Z"
updatedAt: "2026-11-23T11:45:26.343Z"
closedAt: "2026-11-23T11:45:26.343Z"
source: null
approval: {"specSha256":"09c5f68e1f3b652dc10744ea2159a936704149ecdcf7cf057735c4455e65f1c7","source":"repository","actor":"claude-delegated-by-david: delegated by dvdtrsnk for the offline-first mobile data, 2026-11-23","at":"2026-11-23T08:53:08.639Z"}
resolution: {"pullRequests":[],"commit":"9b5f6bdf9c117b800c53ef00c4654a45bb199728","at":"2026-11-23T11:45:26.343Z"}
---
**Blocked by:** sp-0412eb00-5180-4208-bb49-0e4c38ce9600
**Model tier:** medium

## Context

Model tier rationale: One repository's restore decision changes for one failure kind and keeps one small file in the store `[offline-first 01/07]` built; the session lifecycle itself (sign-out, refusal) stays as it is.

`HttpAuthRepository.restore()` checks the stored session with `GET /api/auth/session` when the app starts. When the server cannot be reached it reports `SessionStatus.Unreachable`, and the Apple `SessionGate` then shows only "server unreachable" with a retry, so the app is unusable without a connection even with everything the offline set keeps since `[offline-first 01/07]`. The person (`SessionUser`) is what `SignedIn` needs besides the server.

## Task

Load `kmp-shared`, `testing`, `error-handling` and `mobile-verify`.

1. `OfflineStore` keeps the person of the session in `<account>/session.json` (version, account, the `SessionUser` fields); a file that does not match reads as nothing and is deleted. It goes with everything else when the store is cleared.
2. `HttpAuthRepository` takes the store (optional; `null` keeps today's behavior). After a restore that the server answered with the session and after a sign-in, it keeps the person. A restore whose check fails with `FailureKind.UNAVAILABLE` reports `SignedIn` with the kept person of the stored session when there is one, and `Unreachable` as today when there is none. Every other outcome is unchanged: a refused session is forgotten, which clears the store.
3. `HomeSDK` passes the store it built for the data directory.
4. Tests (commonTest): the kept person after a restore and after a sign-in; an unreachable restore with and without a kept person; a kept person of another account (another token) not used; a refused restore clearing it; sign-out clearing it.

## Touches

- mobile/shared/data/src/commonMain/kotlin/cz/semprec/app/data/OfflineStore.kt (the kept person)
- mobile/shared/data/src/commonMain/kotlin/cz/semprec/app/data/HttpAuthRepository.kt
- mobile/shared/umbrella/src/commonMain/kotlin/cz/semprec/app/sdk/HomeSDK.kt
- mobile/shared/data/src/commonTest/kotlin/cz/semprec/app/data/HttpAuthRepositoryTest.kt
- docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md (opening without a connection)

## Scope

### In scope

- Opening the signed-in app without a connection when the device checked that session before.

### Out of scope

- Any change to `SessionStatus`, `SessionGate` or the sign-in screens.
- Showing that the app is offline (`[offline-first 07/07]`).

## Acceptance criteria

- A cold start without a connection, after the session was checked once on this device, reports `SignedIn` with the kept person, so the app opens its tabs.
- A cold start without a connection and without a kept person still reports `Unreachable`.
- A later request answered `401` signs the device out and removes the kept person with the rest of the store.
- Signing out removes the kept person.
