---
status: accepted
date: 2026-09-10
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# `develop` is the integration branch; `main` advances only via a promotion PR

## Context

Every unit of work lands as its own PR, reviewed by an automated code-review
gate. Releases need a point-in-time version that's known to have passed
that gate as a whole, distinct from the continuously-integrating branch
individual issues merge into.

## Decision

`develop` is the integration branch — all feature/issue work targets it via
PR, gated by the automated code review. `main` holds released versions
only: it advances exclusively through a `develop -> main` promotion PR,
which on merge triggers a release pipeline that tags and publishes a GitHub
Release from the version in `backend/package.json`.

## Consequences

- The promotion PR is reviewed under different rules than a feature PR — a
  release-readiness pass (migrations, config, rollback, security) over the
  whole accumulated diff, not a per-issue acceptance-criteria check
  (`.github/workflows/code-review.yml`, `PROMOTION_SOURCE`/`PROMOTION_TARGET`).
- `main` is always deployable and tied to a published release; in exchange,
  shipping anything requires the extra step of a promotion PR rather than
  every merge to `develop` being independently releasable.

## Amendment 2026-09-24

Re-confirmed over the trunk-based model the `deployment` batch proposed (#187: retire
`develop`, make `main` the only long-lived branch). The repository owner kept this decision;
#249 completed the gate for it instead — `ci` runs on pushes to both branches, a
`promotion-source` check refuses a pull request into `main` from anywhere but `develop`, and
the required checks are listed in `docs/operations/required-checks.md`.
