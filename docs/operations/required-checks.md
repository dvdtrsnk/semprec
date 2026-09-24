# Required checks

Issue #249. The status check contexts that branch protection requires are a contract: a
pull request can merge only when every one of them has reported success for its head. A
context that is required but never reported leaves every pull request pending forever, so
**renaming or removing a job below is a contract change** — update the branch protection
and this document in the same change.

## Branch model

`develop` is the integration branch every issue targets; `main` holds released versions and
advances only through a `develop -> main` promotion pull request
([ADR](../adr/2026-09-10-develop-main-branching-with-release-promotion.md)). Both branches
are protected: a pull request is required, required checks are `strict` (the head must be up
to date with the base), the rules apply to administrators too, and force pushes and
deletions are refused.

The deployment epic (#187) proposed retiring `develop` for a trunk-based `main`. On
2026-09-24 the repository owner kept this model instead; #249 completed the gate for it —
the `ci` triggers on both branches, the `promotion-source` check, and this document.

## Contexts required today

| Context             | Produced by                                                                                                                                 | Required on       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `ci`                | `.github/workflows/ci.yml`, job `ci` — repository scans, lint, format, build, the web workspace                                             | `develop`, `main` |
| `unit`              | `.github/workflows/ci.yml`, job `unit` — the backend unit tier                                                                              | `develop`, `main` |
| `integration`       | `.github/workflows/ci.yml`, job `integration` — the backend integration tier against an ephemeral PostgreSQL created and removed by the run | `develop`, `main` |
| `dependency-check`  | `.github/workflows/ci.yml`, job `dependency-check` — the #173 module-boundary rules                                                         | `develop`, `main` |
| `e2e`               | `.github/workflows/ci.yml`, job `e2e` — the backend e2e scenarios against an ephemeral PostgreSQL                                           | `develop`, `main` |
| `pi-agent-contract` | `.github/workflows/ci.yml`, job `pi-agent-contract` — the pinned pi runtime contract suite (#134) and the pi import-path check              | `develop`, `main` |
| `review`            | `.github/workflows/code-review.yml`, job `review` — runs the code-review bot                                                                | `develop`, `main` |
| `code-review`       | the code-review bot's own Check Run (`GH_CHECK_NAME` in `code-review.yml`) — the review verdict                                             | `develop`, `main` |
| `promotion-source`  | `.github/workflows/ci.yml`, job `promotion-source` — fails a pull request into `main` whose head is not this repository's `develop`         | `main`            |

`protected-paths` (`.github/workflows/protected-paths.yml`) reports on every pull request
but is not a required context.

Every job in `ci.yml` runs on every pull-request update and on every push to `develop` and
`main`, so every commit on either branch carries its own result.
