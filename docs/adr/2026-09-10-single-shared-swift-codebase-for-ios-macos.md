---
status: accepted
date: 2026-09-10
area: [apple]
supersedes: []
superseded-by: null
---

# One Swift codebase serves both iOS and macOS, not two separate projects

## Context

The Semprec Apple client needs to exist on both iOS and macOS. The
alternative to a single codebase is two separate Xcode projects/targets
that each reimplement the same data layer, networking, and most UI logic
against the same backend.

## Decision

`apple/` is a single shared Swift codebase for both the iOS and macOS app —
one app, both platforms. Shared code lives outside any `#if os(iOS)` /
`#if os(macOS)` branch unless the platforms genuinely need different
behavior.

## Consequences

- A platform check used where a shared abstraction would do is a review
  finding, not a style nitpick (`apple/review-rules/rules.md`) — the
  default is to write once and branch only where the platforms truly
  diverge (e.g. navigation chrome, some input handling).
- Feature work is implemented once against both platforms per issue,
  rather than twice against two codebases, at the cost of needing
  abstractions that hold up across both platforms' idioms from the start.
