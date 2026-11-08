---
status: accepted
date: 2026-10-25
area: [mobile, cross-cutting]
supersedes: []
superseded-by: null
---

# Verify mobile changes in CI and Relay, with device tests run locally

## Context

[[2026-10-24-monorepo-holds-backend-web-and-mobile]] records the initial mobile
platform without CI coverage. Its single pipeline, `mobile/scripts/verify`, now
needs automatic execution. Running Apple builds for backend-only changes would
consume a macOS runner without checking changed mobile code. Device ownership on
the shared Relay host also prevents a build from selecting a simulator itself
([[2026-10-24-kotlin-multiplatform-below-native-mobile-ui]]).

## Decision

CI adds two reported, non-required jobs on changes under `mobile/`:
`mobile-android` runs architecture and Android verification on Ubuntu;
`mobile-apple` runs shared Kotlin and Apple verification on an Apple-silicon
macOS runner with Xcode 26 or newer. Node 22 and JDK 17 are selected explicitly;
Tuist and SwiftLint use the versions pinned in the mobile tree. Failed jobs
upload `mobile/build/verify/`.

Pull requests compare their head with its merge base with the event's base SHA.
Pushes to `develop` and `main` compare the pushed head with the event's `before`
SHA, using an empty tree for an initial push. Deleted and renamed mobile paths
count as changes. A failed Git comparison fails detection instead of skipping
verification.

Relay's `implement-issue`, `fix-review-findings`, `merge-pull-request` and
`recover-blocked-issue` workflows add `verify-mobile` after `verify-web`, with
the same failure target and three repair rounds. It fetches remote `develop`
before comparing its merge base with the worktree head. It runs the full mobile
pipeline when that comparison includes `mobile/`, or explicitly reports no
mobile change. Fetch and comparison failures fail the step. The command timeout
is 120 minutes to accommodate cold builds and dependency downloads.

Neither CI nor Relay reserves devices or passes device flags. Their device
steps report NOT RUN. Manual validation before opening a mobile pull request
still runs the full pipeline on reserved devices. Branch protection, release
required contexts and Relay's `wait-checks` remain unchanged; requiring these
new CI contexts needs a separate decision after operational evidence.

## Consequences

Mobile build failures can route Relay into its existing repair loop, and CI
reports them independently of backend and web checks. Device execution remains
separate evidence: CI compiles Apple UI tests but does not run them. The original
monorepo ADR remains a historical record; this decision adds the automatic
verification that its initial implementation lacked.
