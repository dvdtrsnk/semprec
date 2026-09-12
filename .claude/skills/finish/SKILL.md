---
name: finish
description: Finish a feature branch of dvdtrsnk/semprec end to end - bring it up to date with develop by merging (never rebasing), run the full CI pipeline locally, push, open the pull request against develop, drive the three required checks and the code-review-bot to green, resolve review threads, merge, then clean up the worktree and branch. Use when the user says the feature is done, asks to finish, land, merge or ship the branch, or invokes /finish.
---

# Finish a feature branch

Trunk for feature work is `develop` (the repository's default branch).
`main` holds released versions only and advances exclusively through a
`develop -> main` promotion PR — **promotion is not part of this skill and you
must never open, merge or push toward `main` here.**

The main checkout is `/home/node/projects/semprec`. Work happens in a separate
worktree on a feature branch.

## Absolute rules — history is never rewritten

Several bb threads run against this repository at the same time, each in its
own worktree, and PRs land on `develop` while your branch is open. Every step
below is chosen so that no command can destroy someone else's commits:

- **Never rebase a branch that has been pushed, and never force-push
  anything** — not `--force`, not `--force-with-lease`. `--force-with-lease`
  is not a sufficient guard here: a `git fetch` from any concurrent step
  refreshes the remote-tracking ref the lease is measured against, which
  silently re-arms the push. Bring the branch up to date with `git merge`
  instead (§2); a merge only ever adds commits.
- **Never push directly to `develop` or `main`.** Both reject force pushes and
  deletions server-side, but a direct push of any kind bypasses the required
  checks. Everything lands through a PR.
- **Never `git stash`** — the stash stack is shared with every other worktree
  on this machine. If you must set work aside, make a WIP commit.
- **Never `git branch -D`** (use `-d`, which refuses an unmerged branch) and
  never `git worktree remove --force`.
- **Never delete or reset anything you did not create in this session.**

If a step seems to require breaking one of these, stop and ask the user.

## 0. Resolve the situation

1. `git branch --show-current`. Refuse and stop if it is `develop` or `main`.
2. `git worktree list`: note the main checkout path and, if the current
   directory is a separate worktree, its path.
3. `bb status --json`: if `.thread.environment` is rooted in the worktree that
   step 7 will remove, remember it — the session has to move out first.
4. Stop and tell the user if a rebase or merge is already in progress
   (`.git/rebase-merge`, `.git/MERGE_HEAD` in this worktree's git dir).

## 1. Commit what is pending

`git status --short`. Commit anything outstanding. Message style follows this
repository's history: an imperative sentence describing the change, optionally
prefixed with the epic tag the branch belongs to
(`[heartbeat-agent-tools 03/04] Trigger time-based heartbeats ...`). This repo
does **not** use Conventional Commits — do not introduce `feat:` / `fix:`
prefixes. Review what gets staged; never add `dist/`, `node_modules/`, `.env`
or secrets. Do not discard anything.

## 2. Bring the branch up to date with develop — by merging

```
git fetch origin
git merge origin/develop
```

`develop` has branch protection with **`strict: true` (branches must be up to
date before merging)**, so this is not optional: if anything landed on
`develop` while you worked, GitHub will refuse the merge until you do this and
CI re-runs. Expect to come back here at least once during a long review loop.

Resolve conflicts by hand so the feature's intent survives alongside what
landed on trunk — read both sides, never take one wholesale. Ask the user only
about a genuinely ambiguous semantic conflict.

## 3. Run the full CI pipeline locally

A CI round-trip is now ~6 minutes plus the review bot, so never use CI as your
first check. Run exactly what `.github/workflows/ci.yml` runs, in order:

```
cd backend
pnpm install --frozen-lockfile
pnpm run verify

cd ../web
pnpm install --frozen-lockfile
pnpm run verify
```

`verify` is exactly what `.github/workflows/ci.yml` runs, in the same order, so
a local pass means CI has nothing new to say.

Notes:

- The database-backed tiers need no service container — `globalSetup` starts an
  embedded Postgres on a free port, so a concurrent run in another worktree
  does not clash. `SEMPREC_TEST_PG_PORT` pins the port if you ever need it.
- `pnpm run format` (backend and web) fixes formatting; `format:check` failures
  are never worth a CI round.
- If a test is flaky rather than failing, do not retry until it passes and move
  on — a test that fails under load will fail in CI. Diagnose it.

Then read your own diff (`git diff origin/develop`) as a strict reviewer
applying `backend/review-rules/rules.md`, `backend/review-rules/tasks/*.md` and
the matching `web/review-rules/` for frontend changes, plus the conventions in
`.bb/skills/` (choke-point writes, single-writer ownership,
expand/contract migrations, AI calls only through the gateway, English
camelCase canonical keys, labels via i18n). Sweep for debug prints,
commented-out code and files unrelated to this branch. Fix what you find and
commit it.

## 4. Push and open the pull request

```
git push -u origin <branch>          # plain push; if it is rejected, go back to §2
gh pr view --json number,url 2>/dev/null || gh pr create --base develop --fill
```

The base is **`develop`**. If `gh pr create` ever defaults to `main`, that is a
mistake — pass `--base develop` explicitly and verify with
`gh pr view --json baseRefName`.

Write a body that says what changed, why, and how it was verified.

## 5. Review loop (repeat until green, at most 4 rounds)

Three checks are required on `develop`: **`ci`**, **`review`** and
**`code-review`**. All three must pass, and
**`required_conversation_resolution` is on**, so every inline review thread
must also be resolved before the merge button unblocks.

1. Wait in the **background**, never the foreground: `ci` alone runs about
   seven minutes on this repository, which outlives the shell tool's timeout,
   so a foreground `--watch` is killed mid-run every time. Start it detached
   and let the completion re-invoke you:

   ```
   gh pr checks <n> --watch --interval 30   # run_in_background: true
   ```

   Do not end your turn believing the work is done while that wait is still
   armed. A pull request left green but unmerged goes stale the moment another
   branch lands, and nothing wakes you to notice.
2. Read the findings:
   - summary comment:
     `gh api repos/dvdtrsnk/semprec/issues/<n>/comments --jq '.[] | select(.user.login=="github-actions[bot]") | .body'`
   - inline threads:
     `gh api repos/dvdtrsnk/semprec/pulls/<n>/comments --jq '.[] | "\(.id) \(.path):\(.line // .original_line) \(.body)"'`
   - CI failure log: `gh run view <run-id> --log-failed`
3. Triage every finding against the `review-rules/` for the platform it
   touches. The bot is configured with `REVIEW_BLOCK_SEVERITY: medium`, so
   **critical, high and medium findings block the merge** — fix them. Fix a low
   finding when it is cheap and clearly right; otherwise reply on the thread
   with the reason. A finding that is simply wrong gets a reasoned reply, not a
   code change made to appease it:
   `gh api repos/dvdtrsnk/semprec/pulls/<n>/comments/<id>/replies -f body=...`
4. Fix, re-run the §3 verification for whatever you touched, commit, `git push`
   (plain push, never force). The bot remembers earlier rounds — do not
   re-explain findings it already saw fixed.
5. Check whether `develop` moved while you were iterating
   (`git fetch origin && git log --oneline HEAD..origin/develop`). If it did,
   go back to §2 — `strict: true` means the merge stays blocked otherwise.
6. Confirm the bot actually reviewed something. A green `code-review` does not
   mean the diff was inspected — if the scope globs match nothing, the run logs
   `No platforms were reviewed (all skipped or no matching files)` and still
   reports success. That is exactly how `review-rules/scope.md` corruption went
   unnoticed for 14 merged PRs (see the note in `.prettierignore`). Check the
   run log before trusting the check:
   ```
   gh run view <review-run-id> --log | grep -E "found platform|reviewed|skipped" | head
   ```
   If everything was skipped, the review did not happen — fix the scope rules
   rather than merging on a check that inspected nothing.
7. Before declaring the round green, confirm no unresolved threads remain:
   ```
   gh api graphql -f query='{ repository(owner:"dvdtrsnk", name:"semprec") { pullRequest(number: <n>) { reviewThreads(first:100) { nodes { isResolved path } } } } }'
   ```
   The bot resolves threads it has fixed via a dedicated token, but that has
   silently failed before (see the comment block in
   `.github/workflows/code-review.yml`). If a thread the bot addressed is still
   open, resolve it yourself with a short reply saying what fixed it.

The theme behind both checks: on this repository a green required check has
more than once meant "nothing ran" rather than "nothing is wrong". Confirm what
a check actually did before you rely on it.

If it is still red after 4 rounds, stop and hand the remaining findings to the
user rather than merging around them.

## 6. Merge

The user has standing authorization for this step: once `ci`, `review` and
`code-review` all pass, no critical/high/medium finding is open and every
thread is resolved, merge without pausing to ask again.

```
gh pr merge <n> --merge --delete-branch
```

`--merge`, not `--squash`: `develop`'s history is merge commits
(`Merge pull request #NNN from dvdtrsnk/...`) and the individual commits on the
branch are worth keeping. Merging can only add to `develop` — it never rewrites
what is already there, which is why no variant of this step needs a force flag.

Confirm with `gh pr view <n> --json state,mergedAt,baseRefName` and check that
`baseRefName` is `develop`.

If GitHub refuses the merge:

- *"not up to date"* / behind base → back to §2. Expect this whenever a
  sibling pull request merged while your checks were running: your branch was
  green and is now behind. It costs one merge from `develop` and one more pass
  through §5 — it is not a reason to hand the branch back to the user.
- *unresolved conversations* → back to §5.6.
- If the **tool layer** blocks the command (a permission gate, not a GitHub
  refusal), retry the exact same command once. If it is still blocked, stop and
  tell the user — do not route around it through the raw API.

## 7. Local cleanup

Run everything with `git -C /home/node/projects/semprec ...`; never `cd` into a
directory that is about to be removed.

1. Inspect the main checkout: `git -C <main> status --short` and
   `git -C <main> branch --show-current`. If it sits on another feature branch
   with uncommitted work, another thread owns it — leave it alone, run only
   `git -C <main> fetch origin develop:develop` (updates the local ref without
   switching) and skip to 7.4.
2. Otherwise `git -C <main> checkout develop && git -C <main> pull --ff-only origin develop`.
   `--ff-only` guarantees this can never create or clobber anything locally.
3. If this session's environment is rooted in the worktree (§0.3), call
   `update_environment_directory` with the main checkout path **now** and stop
   the turn; continue on the next one.
4. Remove the worktree and branch:
   ```
   git -C <main> worktree remove <worktree>
   git -C <main> branch -d <branch>
   git -C <main> fetch --prune
   ```
   `worktree remove` without `--force` and `branch -d` (not `-D`) both refuse
   when something would be lost — if either refuses, report what is left rather
   than overriding it. For a bb-managed worktree environment, prefer archiving
   its thread and letting bb destroy the worktree.

## Report

State the PR URL, how many review rounds ran and what each fixed, anything left
open and why, the merge commit SHA on `develop`, and the final state of the
worktree and branch. If you stopped early, say exactly where and what the user
must do next.
