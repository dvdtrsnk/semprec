---
status: accepted
date: 2026-11-24
area: [mobile]
supersedes: [2026-10-25-conditional-mobile-verification-in-ci-and-relay]
superseded-by: null
---

# Mobile verification follows the Android and Apple areas a change touches

## Context

[[2026-10-25-conditional-mobile-verification-in-ci-and-relay]] runs both mobile CI jobs, and
Relay's full mobile pipeline, for any change under `mobile/`. A change to one app therefore
also pays for the other: a Swift-only change runs the Android job, and an Android-only change
would occupy a macOS runner for over an hour without checking anything it changed. The backend
and web pipelines now run only for the areas a change touches, decided by one detector,
`.github/scripts/changed-areas.mjs` (`docs/architecture/delivery-and-operations.md`). The mobile
jobs use the same detector so that one rule decides every platform.

The Android job could not simply stand alone: detekt, which covers `android/`, `shared/` and
`build-logic/src`, ran only in the `shared` step, and that step needs an Apple silicon Mac.

## Decision

The detector reports two mobile areas. A change under `mobile/android/` is `android`, a change
under `mobile/apple/` is `apple`, and any other change under `mobile/` (shared Kotlin, the
Gradle build, verify scripts, docs) is both; a `review-rules/` directory is neither.

- `mobile-android` runs for `android` and `mobile-apple` for `apple`, on pull requests and pushes
  alike. Both remain reported, not required.
- The `android` step of `mobile/scripts/verify` runs `detektAll -PdetektAutoFix=false` as well,
  so the Android job checks an Android-only Kotlin change on its own.
- `mobile-apple` runs `mobile/scripts/verify architecture shared apple`: with the architecture
  rules in both jobs, a change to one app still gets them.
- Relay's `verify-mobile` runs `architecture android` for `android` alone, `architecture shared
  apple` for `apple` alone, the full `architecture shared android apple` for both, and reports
  that it is not needed for neither.
- A comparison git cannot make counts as a change to both apps instead of failing detection: the
  failure runs more verification, never less. A failed fetch still fails Relay's step.
- Both CI jobs restore the Gradle User Home through `gradle/actions/setup-gradle` with its MIT
  `basic` cache provider, so tasks whose inputs did not change come from the build cache.

Devices stay as before: neither CI nor Relay reserves one, their device steps report NOT RUN,
and a manual pull request that touches mobile still runs the full pipeline on reserved devices.

## Consequences

A change to one app no longer runs the other app's job. detekt runs in both the `shared` and the
`android` step, so `verify all` runs it twice; Gradle finds the second run up to date. A wrong rule
in the detector skips a mobile job for a change that needed it, so the detector's rules and the
gates that consume them are tested together (`.github/scripts/changed-areas.test.mjs`,
`.github/scripts/area-gates.test.mjs`).
