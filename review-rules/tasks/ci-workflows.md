Check the GitHub Actions workflows this pull request touches under
`.github/workflows/`. These files are the merge gate: the `ci`,
`protected-paths` and `review` job ids are required status check contexts on
`develop` (each workflow says so in a comment), and `code-review.yml` produces
the required `code-review` Check Run. A change here can switch the gate off for
every later pull request, so read it as the most consequential diff in the
repository. Report nothing for files outside `.github/workflows/`.

1. A change to any workflow that the linked issue's `## Task` does not
   explicitly call for — critical. Quote the Task line that authorizes it, or
   report its absence. A pull request that edits the gate it is judged by, for
   a reason nobody asked for, is gate self-neutralization rather than a normal
   change.
2. A change that weakens or removes a required check — critical. This
   includes: renaming or splitting a job whose id is a required context;
   deleting or disabling a step that can fail the job; a new `if:` that can
   skip the job or its steps while still reporting success; `continue-on-error:
   true` on a step that gates the verdict; `|| true`, `exit 0`, or a dropped
   `set -o pipefail` that turns a failing command green; narrowing the `on:`
   triggers so the check stops running on pull requests it used to run on;
   lowering `REVIEW_BLOCK_SEVERITY` or changing `GH_CHECK_NAME`; and making the
   finalizer stop marking an interrupted Check Run as completed or stop writing
   its `crb-outcome` marker.
3. A `permissions:` grant wider than the job's steps use — high. Name the
   scope and show that no step needs it. A `write` scope added to a workflow
   triggered by `pull_request_target`, or a move from an explicit
   `permissions:` block to the default token permissions, is critical.
4. A secret reaching a step that runs code the pull request controls — high,
   critical on `pull_request_target`. That covers a secret in `env:` of a step
   that executes checked-out pull-request code (a build, a test, a script from
   the working tree), a `pull_request_target` workflow that checks out or runs
   the pull request's head, and a secret echoed, written to `GITHUB_OUTPUT` /
   `GITHUB_ENV`, or passed on a command line where it reaches the log.
5. A `${{ github.event.* }}`, `${{ inputs.* }}` or other attacker-influenced
   expression interpolated directly into a `run:` script instead of being
   passed through `env:` — high. A pull request title, branch name or label is
   shell source once it is inlined.
6. A pinned dependency silently unpinned — high. That is: a checked-out
   repository `ref:` moved from a commit SHA to a branch or tag (the
   `code-review-bot` checkout above all, whose revision produces the required
   Check Run); an action reference moved to a floating ref (`@main`,
   `@master`, or a less specific version than before); a tool version
   (`pnpm`, `node-version`) removed or widened; or a download fetched without
   the failure checks the workflow already applies to it.
7. A timeout or concurrency setting that can strand a required check — high.
   That covers: a `timeout-minutes` removed or lowered below what the job's own
   comments derive it from; a `concurrency.group` whose key no longer includes
   the pull request number, so unrelated pull requests cancel each other's
   required checks; `cancel-in-progress` on a job whose cancellation leaves its
   Check Run neither completed nor finalized; and a finalizer step losing
   `if: always()`.
8. A comment in a workflow that states something the YAML beside it no longer
   does — a derivation whose numbers no longer add up, a claim about which
   contexts are required, a statement about what a step guarantees — medium.
   These comments are how the next editor learns what must not change.
