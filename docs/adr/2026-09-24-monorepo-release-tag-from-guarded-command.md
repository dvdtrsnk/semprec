---
status: accepted
date: 2026-09-24
area: [cross-cutting]
supersedes: [2026-09-10-develop-main-branching-with-release-promotion]
superseded-by: null
---

# One monorepo release tag, created only by a guarded command on a green `main` commit

## Context

[[2026-09-10-develop-main-branching-with-release-promotion]] made `main` the branch that holds
released versions and had a release pipeline tag each promotion merge from the version in
`backend/package.json`. That kept the branch model but left the version itself loose: it lives in
one package's manifest while every other package carries its own `version`, nothing checks that
the commit being tagged passed CI, and a tag can be pushed by hand onto any commit.

Issue #189 (deployment batch, #187) needs a release identity that a later deploy step can trust:
a tag that names exactly one commit, and only a commit that is `main`'s head and passed the
required checks. The alternatives were keeping the version in `backend/package.json` (a version
per package, bumped by hand, and tagged by a workflow that does not look at CI results), or tagging
from a workflow on every push to `main` (which would tag every promotion whether or not a release
was intended, and would have to wait on the other jobs of the same push).

## Decision

This replaces [[2026-09-10-develop-main-branching-with-release-promotion]] as a whole; its branch
model carries over unchanged. `develop` is the integration branch — all feature/issue work targets
it via PR, gated by the automated code review. `main` holds released versions only and advances
exclusively through a `develop -> main` promotion PR, reviewed under the release-readiness rules
rather than a per-issue acceptance-criteria check. What changes is how a release is made: merging
the promotion PR no longer tags or publishes anything by itself.

The monorepo has exactly one version: a `vMAJOR.MINOR.PATCH` git tag (no leading zeros, no
pre-release or build suffix). No `package.json` carries a version of its own — each keeps the
`0.0.0` placeholder, and a unit test in `backend/packages/release` fails any that does not.

A release tag is created only by the guarded command in `backend/packages/release`
(`docs/operations/releases.md`), which takes the tag and a full commit SHA and refuses unless:
`main` is protected and its head is exactly that SHA, the tag name does not exist on the remote,
no other release tag already points at that SHA, and every `ci.yml` job that runs on a push to
`main` has a GitHub Actions check run whose newest run on that exact SHA completed successfully.
It re-reads `main`'s head right before tagging, creates an annotated tag on the SHA itself (never
on a branch name), and pushes it without force, so the remote refuses a duplicate that appeared
in the meantime.

## Consequences

- A release is a deliberate act by a maintainer, not a side effect of a promotion merge: a green
  `main` commit can stay untagged, and each commit can be tagged at most once.
- Eligibility is bound to the SHA, so a later push to `main` cannot make an unchecked commit
  releasable, and a re-run of a failed job counts only when the re-run itself succeeded.
- The list of required jobs is written in the command. Renaming or adding a `ci.yml` job is
  already a contract change (`docs/operations/required-checks.md`); it now also updates that
  list.
- `.github/workflows/release.yml` still reads `backend/package.json`, but with the version pinned
  to the placeholder it never tags anything; retiring or repointing it at release tags is left
  to the deployment issue that consumes them.
- Deployment on a tag push is not part of this decision.
