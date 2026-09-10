---
status: accepted
date: 2026-09-10
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# One repo holds backend, Apple, and web, not one repo per platform

## Context

Semprec ships a backend, an iOS/macOS app, and a web frontend against the
same API and data model. Splitting them into separate repos would mean
cross-platform issues span multiple PRs/repos and shared context (the
choke-point API shape, canonical keys, module contracts) has to be
duplicated or linked across repo boundaries.

## Decision

This repo is a monorepo for the whole product: `backend/` (a pnpm
workspace — all current implementation work), `apple/` (shared iOS/macOS
Swift codebase, scaffold-only until its issue queue starts), and `web/`
(React/TypeScript frontend). Each platform has its own independent
review-rules and scope, reviewed separately per PR
(`backend/review-rules/context.md`, `apple/review-rules/context.md`,
`web/review-rules/context.md`).

## Consequences

- A single sequential issue queue and a single `develop`/`main` history
  cover the whole product
  ([[2026-09-10-develop-main-branching-with-release-promotion]]), so
  cross-platform context (API contracts, canonical keys) never has to be
  synced across repos.
- Each platform's automated review only ever sees its own file globs
  (`review-rules/scope.md` per platform), so the monorepo doesn't mean one
  undifferentiated review — findings stay scoped to the platform a PR
  actually touches.
