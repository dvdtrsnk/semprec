# Handover for sp-c5c1294b-c8bd-407d-945b-6ce0daae5eae

Implementation commit: 9b5f6bdf9; the decision record and ADR wording: 913780729.

The offline store keeps the person the server last confirmed for the session (`<account>/session.json`): after every
restore the server answered and every sign-in. A restore that gets no answer, a `5xx` or a `429` reports
`SessionStatus.SignedIn` with that person, so the app opens without a connection; with no kept person it stays
`Unreachable`, and every other answer behaves as before (a `401` signs out). The store's parts share one account root
and one lock. `SessionStatus`, `SessionGate` and the sign-in screens are unchanged.

The offline set's decision now states the opening without a connection
(`docs/adr/2026-11-23-mobile-keeps-the-answers-of-the-offline-set.md`, decision record
`issues/decisions/sp-c5c1294b-c8bd-407d-945b-6ce0daae5eae.md`).

Tests: `HttpAuthRepositoryTest` (kept person after a restore and a sign-in, offline restore with and without a kept
person, a `401`, the session end) and `OfflineStoreTest`.

## Verification

Verification on the branch head `94337db72` (all seven issues), 2026-11-23, iOS simulator `C1C0ED72-76CF-4283-81B1-2FE039AF9027` (iPhone 18 Pro, iOS 27.0) and Android emulator `device_lab_api36_1` (API 36), both reserved through `bb device-lab` and released afterwards:

- `mobile/scripts/verify architecture shared --ios-simulator …`: architecture PASS (10 rules, node tests); shared PASS: JVM 1928 tests (data 603, domain 362, presentation 926, umbrella 37), macOS native 1890, iOS simulator native 1890, no failure; detekt clean.
- `mobile/scripts/verify android --android-serial emulator-5554`: PASS: debug and release builds, 26 unit tests, lint, 18 of 18 instrumented tests. The first two attempts failed before or during the instrumented tests because the host's adb server (37.0.1) aborted in its mDNS bridge (crash report: `adbmdns_bridge` panic); the passing run used an adb server started with `ADB_MDNS=0`.
- `mobile/scripts/verify apple --ios-simulator …`: SwiftLint, Tuist, the Debug and Release builds for the iOS Simulator, the iPhone and macOS, and the UI test build PASS; `test on macOS` FAIL: the XCTest host on macOS hung in dyld before it connected ("The test runner hung before establishing connection"), three times; launched directly, with the same `DYLD_*` environment, the same macOS app starts normally. The two later commands, run separately with the same `xcodebuild` commands on the same head: `Semprec` scheme on the iOS simulator 817 of 817 passed, `SemprecUITests` 1 of 1 passed.
- Not verified: the apps against a real server (it needs a person's sign-in), and the macOS tests (above).
