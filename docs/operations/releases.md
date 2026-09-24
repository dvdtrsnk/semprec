# Releases

Issue #189. The monorepo has one version, a `vMAJOR.MINOR.PATCH` git tag on `main`
([ADR](../adr/2026-09-24-monorepo-release-tag-from-guarded-command.md)). No package carries a
version of its own; every `package.json` keeps the `0.0.0` placeholder.

## Tagging a release

From a checkout whose `origin` is the GitHub repository, with `gh` authenticated and allowed to
push tags:

```sh
cd backend
pnpm install --frozen-lockfile
pnpm --filter @semprec/release run release-tag v1.2.3 <full-sha-of-main-head>
```

The command tags the commit only when all of these hold, and otherwise exits with code 2 and
the reason, having created nothing:

| Rule                                                          | Refused example                                   |
| ------------------------------------------------------------- | ------------------------------------------------- |
| The tag is `vMAJOR.MINOR.PATCH`, no leading zeros, no suffix  | `1.2.3`, `v1.2`, `v01.2.3`, `v1.2.3-rc.1`         |
| The target is a full 40-character commit SHA                  | `main`, an abbreviated SHA                        |
| `main` is protected and its current head is exactly that SHA  | an older `main` commit, a `develop` commit        |
| The tag does not exist on the remote                          | re-running `v1.2.3` after it was pushed           |
| No other release tag already points at that SHA               | tagging an already released commit as `v1.2.4`    |
| Every push-triggered `ci.yml` job succeeded on that exact SHA | a failed, cancelled, still running or missing job |

The jobs checked are `promotion-source`, `ci`, `unit`, `integration`, `dependency-check`,
`e2e` and `pi-agent-contract` — the jobs of [`ci.yml`](required-checks.md) that run on a push to
`main`. Only check runs created by GitHub Actions count, and when a job was re-run only its
newest run does. `review` and `code-review` run on pull requests only; they gated the promotion
pull request whose merge produced the commit.

`main`'s head is read again just before the tag is created, and the tag is pushed without
force, so a commit that stopped being the head or a tag that appeared meanwhile is still
refused. Exit code 1 means the command could not finish (git, `gh` or the network failed) —
read its error; nothing is released unless the push itself succeeded.

Pushing a tag does not deploy anything yet.
