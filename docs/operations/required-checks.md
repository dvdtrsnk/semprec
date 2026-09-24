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

## Contexts required today

| Context            | Produced by                                                                                                                         | Required on       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `ci`               | `.github/workflows/ci.yml`, job `ci` — build, lint, format, all test tiers, repository checks                                       | `develop`, `main` |
| `review`           | `.github/workflows/code-review.yml`, job `review` — runs the code-review bot                                                        | `develop`, `main` |
| `code-review`      | the code-review bot's own Check Run (`GH_CHECK_NAME` in `code-review.yml`) — the review verdict                                     | `develop`, `main` |
| `promotion-source` | `.github/workflows/ci.yml`, job `promotion-source` — fails a pull request into `main` whose head is not this repository's `develop` | `main`            |

`protected-paths` (`.github/workflows/protected-paths.yml`) reports on every pull request
but is not a required context.

`ci` runs on every pull-request update and on every push to `develop` and `main`, so every
commit on either branch carries its own result.

## Tier names reserved for the CI gate

The `deployment` batch splits the single `ci` job into named tier jobs. These names are fixed
now so branch protection can be written against them:

| Context             | Tier                                              | Added by |
| ------------------- | ------------------------------------------------- | -------- |
| `unit`              | unit tests                                        | #250     |
| `integration`       | integration tests against an ephemeral PostgreSQL | #250     |
| `dependency-check`  | module-boundary and dependency checks             | #250     |
| `e2e`               | end-to-end scenarios                              | #188     |
| `pi-agent-contract` | pi agent runtime contract tests                   | #188     |

Each one becomes required on both `develop` and `main` in the change that adds its job.
