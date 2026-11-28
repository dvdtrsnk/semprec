---
name: finish
description: Finish a feature branch of dvdtrsnk/alldots end to end on the Mac mini - bring it up to date with develop by merging (never rebasing), run the full CI pipeline locally (and mobile/scripts/verify when the branch changes mobile/), push it through the Access Hub GitHub authorization by recreating its commits with the Git Data API, open the pull request against develop, drive all required checks and the code-review-bot to green, resolve review threads, merge, then clean up. Use when the user says the feature is done, asks to finish, land, merge, push or ship the branch, or invokes /finish.
---

# Finish a feature branch

Trunk for feature work is `develop` (the repository's default branch).
`main` holds released versions only and advances exclusively through a
`develop -> main` promotion PR — **promotion is not part of this skill and you
must never open, merge or push toward `main` here.**

## This machine: GitHub only through Access Hub

The skill runs on the user's Mac mini, and three facts about it shape every
step from §4 on:

- **Neither `git push` nor a local `gh` has GitHub credentials**, and none may
  be set up: credentials stay in Access Hub, never copied into a global
  profile. GitHub is reached only through the project's Access Hub
  authorization named `dvdtrsnk` (connector *GitHub CLI*). Find its
  `accountId` with `access_hub_context`; it must be in state `ready`. Its one
  operation is `run`, which runs `gh` with the arguments in `argv`.
  Below, **"hub `gh …`"** means `access_hub_call` with that `accountId`, tool
  `run` and `argv` set to the words after `gh`, for example
  `{"argv": ["pr", "checks", "2110", "--json", "name,bucket"]}`.
- **Hub `gh` runs in the main checkout**
  (`~/Developer/Projects/alldots`), not in your worktree. That checkout is not
  your branch. Its local `develop` is a local integration line that has
  diverged from `origin/develop`. So never let hub `gh` infer anything from the
  checkout: always name the pull request number, the endpoint or the SHA.
  `gh pr create`, `gh pr merge`, `gh pr checkout` and `gh repo sync` are
  therefore not used. `-H`/`--head` is an immutable flag of the authorization,
  so `gh pr create --head` is rejected anyway. A hub call has a 5-minute
  timeout and 1 MiB of input.
- **Pushing means recreating the commits** with GitHub's Git Data API
  (`.github/scripts/mirror-commits.mjs`, §4). GitHub hashes what it is given the
  way git does, so every blob, tree and commit gets the same SHA as locally,
  and the branch ref then moves with an ordinary fast-forward. Hub `gh` reads
  the payload files from your worktree's git directory, which lies inside the
  main checkout's `.git` and so within reach of a process running there.

## Absolute rules — history is never rewritten

Several bb threads run against this repository at the same time, each in its
own worktree, and PRs land on `develop` while your branch is open. Every step
below is chosen so that no command can destroy someone else's commits:

- **Never rebase a branch that has been pushed, and never force anything**
  — no `--force` push and no `"force": true` on a ref update. Bring the branch
  up to date with `git merge` instead (§2); a merge only ever adds commits.
- **Never update `develop` or `main` directly.** Both reject force pushes and
  deletions server-side. A direct ref update of any kind bypasses the required
  checks. Everything lands through a PR.
- **Never change the main checkout.** Do not check out, pull, reset, commit or
  delete anything there. `git -C <main> fetch` (remote-tracking refs only) is
  the one command allowed against it.
- **Never `git stash`** — the stash stack is shared with every other worktree
  on this machine. If you must set work aside, make a WIP commit.
- **Never `git branch -D`** (use `-d`, which refuses an unmerged branch) and
  never `git worktree remove --force`.
- **Never delete or reset anything you did not create in this session.**
- **Never work around Access Hub.** Do not use a token, a `git` credential, or
  a raw HTTP call outside the authorization. If an operation is refused, report
  it.

If a step seems to require breaking one of these, stop and ask the user.

## 0. Resolve the situation

1. `git branch --show-current`. Refuse and stop if it is `develop` or `main`.
2. `git worktree list`: note the main checkout path (the first entry,
   normally `~/Developer/Projects/alldots`) and your worktree's path.
   `git rev-parse --absolute-git-dir` is your worktree's git directory. The
   payloads of §4 go into `<git-dir>/finish-mirror/`.
3. `bb status --json`: note whether `.thread.environment` is rooted in your
   worktree, which is what a bb-managed environment looks like (§8).
4. Stop and tell the user if a rebase or merge is already in progress
   (`rebase-merge` or `MERGE_HEAD` in your git directory).
5. `access_hub_context`: the `dvdtrsnk` GitHub authorization must be listed
   and `ready`. If it is not, stop: there is no other way to reach GitHub.

## 1. Commit what is pending

`git status --short`. Commit anything outstanding. Message style follows this
repository's history: an imperative sentence describing the change, optionally
prefixed with the epic tag the branch belongs to
(`[heartbeat-agent-tools 03/04] Trigger time-based heartbeats ...`). This repo
does **not** use Conventional Commits — do not introduce `feat:` / `fix:`
prefixes. Review what gets staged; never add `dist/`, `node_modules/`, `.env`
or secrets. Do not discard anything.

Do not sign commits (`commit.gpgsign` stays unset): GitHub cannot recreate a
signed commit with the same SHA, and §4 refuses one.

## 2. Bring the branch up to date with develop — by merging

```
git fetch origin
git merge origin/develop
```

`git fetch` reads anonymously, so it works without credentials.

`develop` has branch protection with **`strict: true` (branches must be up to
date before merging)**, so this is not optional: if anything landed on
`develop` while you worked, GitHub will refuse the merge until you do this and
CI re-runs. Expect to come back here at least once during a long review loop.

Resolve conflicts by hand so the feature's intent survives alongside what
landed on trunk — read both sides, never take one wholesale. Ask the user only
about a genuinely ambiguous semantic conflict.

## 3. Run the full CI pipeline locally

A CI round-trip is now ~6 minutes plus the review bot, so never use CI as your
first check. From the repository root, run the steps of
`.github/workflows/ci.yml` that `verify` does not contain, then `verify` itself:

```
node .github/scripts/check-review-scope.mjs
node .github/scripts/issues.mjs validate
node .github/scripts/adr.mjs --platform backend > /dev/null

cd backend
pnpm install --frozen-lockfile
pnpm run verify

cd ../web
pnpm install --frozen-lockfile
pnpm run verify
```

`ci.yml` also runs `issues/check-pr-completion.mjs`. It reads the pull
request's event, so it cannot run here. It checks one thing you control: a PR
body whose first line is `Repository-Issue: <id>` needs that issue's record to
exist on the base already. An issue record created in the same PR fails it.

Notes:

- The database-backed tiers need no service container — `globalSetup` starts an
  embedded Postgres on a free port, so a concurrent run in another worktree
  does not clash. `ALLDOTS_TEST_PG_PORT` pins the port if you ever need it.
- `pnpm run format` (backend and web) fixes formatting; `format:check` failures
  are never worth a CI round.
- If a test is flaky rather than failing, do not retry until it passes and move
  on — a test that fails under load will fail in CI. Diagnose it.

If the branch changes anything under `mobile/`
(`git diff --name-only origin/develop... -- mobile/` prints a path), also run
the mobile pipeline from the repository root, with an iOS simulator and an
Android emulator reserved through `bb device-lab` (the `mobile-verify` skill in
`.bb/skills/` explains each step), and release them afterwards:

```
bb device-lab reserve --platform ios
bb device-lab reserve --platform android
mobile/scripts/verify --ios-simulator <UDID> --android-serial <serial>
bb device-lab release --all
```

Run `verify` in the background and capture its PID. The simulators on this
machine are shared and sometimes stop answering: a test runner that "hung
before establishing connection", an `iosSimulatorArm64Test` that makes no
progress, a screenshot that never returns. When a device cannot be reserved,
or a device step makes no progress for 15 minutes, stop only the process you
started. Then run `verify` again without that device's flag, so its device
steps report NOT RUN and every other step still runs. Do not hold the pull
request on a device: the `mobile-android` and `mobile-apple` checks are not
required. Never restart CoreSimulator or a device another thread reserved.

`bb device-lab list --json` shows the `udid` and adb `serial` of each device.
CI reports the non-required `mobile-android` and `mobile-apple` jobs for
changes under `mobile/`; Relay runs `verify-mobile` after `verify-web`. Both
omit device steps (NOT RUN), so this local run supplies device-test evidence
before the change merges. Put its summary into the pull request body, each
step as PASS, FAIL or NOT RUN. Give a reason for every NOT RUN step (flag not
given, device unavailable, device step stalled).

Then read your own diff (`git diff origin/develop`) as a strict reviewer
applying `backend/review-rules/rules.md`, `backend/review-rules/tasks/*.md` and
the matching `web/review-rules/` for frontend changes, `mobile/review-rules/`,
`mobile/android/review-rules/` and `mobile/apple/review-rules/` for mobile
changes, `review-rules/` for the repository root, `.github/` and the skills (a
file belongs to the platform whose directory is the longest prefix of its
path), plus the conventions in `.bb/skills/` (choke-point writes, single-writer
ownership, the baseline schema edited in place, AI calls only through the
gateway, English camelCase canonical keys, labels via i18n). Sweep for debug
prints, commented-out code and files unrelated to this branch. Fix what you
find and commit it.

## 4. Push through the Git Data API

1. Fetch what GitHub has, then plan the commits it lacks:

   ```
   git fetch origin
   git ls-remote --heads origin <branch>      # empty: the branch is new
   node .github/scripts/mirror-commits.mjs --out <git-dir>/finish-mirror origin/develop [origin/<branch>]
   ```

   Name `origin/<branch>` only when `ls-remote` printed it. Then fetch it first
   (`git fetch origin <branch>:refs/remotes/origin/<branch>`). The script
   prints a plan. It refuses a signed commit, a submodule, a root commit and a
   payload over one call's limit. Report a refusal and stop.
2. Make every step of the plan in order with hub
   `gh api <endpoint> --method POST --input <input> --jq .sha`. The SHA printed
   must equal the step's `expect`. Stop at the first difference: GitHub did not
   reproduce that object, and nothing may point at it. Re-making a step that
   already succeeded is harmless, because GitHub returns the same object.
3. Move the branch to the plan's `head`:
   - new branch: hub `gh api repos/dvdtrsnk/alldots/git/refs --method POST -f ref=refs/heads/<branch> -f sha=<head>`;
   - existing branch: hub `gh api repos/dvdtrsnk/alldots/git/refs/heads/<branch> --method PATCH -f sha=<head> -F force=false`.

   `force=false` accepts only a fast-forward. If GitHub refuses it, the remote
   branch has a commit you do not have. Fetch it, merge it as in §2, and plan
   again. Never force it.
4. Confirm the push: `git fetch origin <branch>:refs/remotes/origin/<branch>`
   then `git rev-parse origin/<branch>` must equal `git rev-parse HEAD`. Delete
   `<git-dir>/finish-mirror/`.

## 5. Open the pull request

Look for an open pull request of the branch first:
hub `gh api "repos/dvdtrsnk/alldots/pulls?head=dvdtrsnk:<branch>&state=open" --jq ".[].number"`.
If there is none, write the body to `<git-dir>/finish-pr-body.md` and open one:

```
hub gh api repos/dvdtrsnk/alldots/pulls --method POST -f head=<branch> -f base=develop -f title=<title> -F body=@<git-dir>/finish-pr-body.md
```

The base is **`develop`**. Confirm with
hub `gh pr view <n> --json baseRefName,headRefName,url`.

Write a body that says what changed, why, and how it was verified, with the
mobile summary of §3 when there is one.

## 6. Review loop (repeat until green, at most 4 rounds)

`develop` requires the checks listed in `docs/operations/required-checks.md`
(`ci`, `unit`, `integration`, `dependency-check`, `e2e`, `pi-agent-contract`,
`review`, `code-review` — that document is authoritative if this list and it
ever disagree). All of them must pass, and **`required_conversation_resolution`
is on**, so every inline review thread must also be resolved before the merge
button unblocks.

1. Read the checks with hub
   `gh pr checks <n> --json name,bucket,state,link`. While any check is
   pending, wait in the **background**: start `sleep 270` with the Bash tool's
   `run_in_background: true`, end the turn, and read the checks again when it
   completes. `ci` alone runs about seven minutes. A hub call ends after 5
   minutes, so a `--watch` inside one never sees it through. Do not declare the
   work or the merge done while a wait is armed and unresolved. A pull request
   left green but unmerged goes stale the moment another branch lands, and
   nothing wakes you to notice.
2. Read the findings:
   - summary comment:
     hub `gh api repos/dvdtrsnk/alldots/issues/<n>/comments --jq '.[] | select(.user.login=="github-actions[bot]") | .body'`
   - inline threads:
     hub `gh api repos/dvdtrsnk/alldots/pulls/<n>/comments --jq '.[] | "\(.id) \(.path):\(.line // .original_line) \(.body)"'`
   - CI failure log: hub `gh run view <run-id> --log-failed`
3. Triage every finding against the `review-rules/` for the platform it
   touches, with the `fix-review-findings` skill in `.bb/skills/`. The bot is
   configured with `REVIEW_BLOCK_SEVERITY: medium`, so **critical, high and
   medium findings block the merge** — fix them. Fix a low finding when it is
   cheap and clearly right; otherwise reply on the thread with the reason. A
   finding that is simply wrong gets a reasoned reply, not a code change made
   to appease it:
   hub `gh api repos/dvdtrsnk/alldots/pulls/<n>/comments/<id>/replies -f body=...`
4. Fix, re-run the §3 verification for whatever you touched, commit, and push
   with §4 (the plan now names `origin/<branch>` too). The bot remembers earlier
   rounds — do not re-explain findings it already saw fixed.
5. Check whether `develop` moved while you were iterating
   (`git fetch origin && git log --oneline HEAD..origin/develop`). If it did,
   go back to §2 — `strict: true` means the merge stays blocked otherwise.
6. Confirm the bot actually reviewed something. A green `code-review` does not
   mean the diff was inspected — if the scope globs match nothing, the run logs
   `No platforms were reviewed (all skipped or no matching files)` and still
   reports success. That is exactly how `review-rules/scope.md` corruption went
   unnoticed for 14 merged PRs (see the note in `.prettierignore`). Check the
   run log before trusting the check (the run id is in the `link` of the
   `review` check):
   ```
   hub gh run view <review-run-id> --log      # then look for "found platform", "reviewed", "skipped"
   ```
   If everything was skipped, the review did not happen — fix the scope rules
   rather than merging on a check that inspected nothing. If
   `.relay/review-policy.json` has `enabled: false`, the owner has paused the
   bot. The review checks then report an explained neutral waiver, and the
   review of §3 is the review.
7. Before declaring the round green, confirm no unresolved threads remain:
   ```
   hub gh api graphql -f query='{ repository(owner:"dvdtrsnk", name:"alldots") { pullRequest(number: <n>) { reviewThreads(first:100) { nodes { id isResolved path } } } } }'
   ```
   The bot resolves threads it has fixed via a dedicated token, but that has
   silently failed before (see the comment block in
   `.github/workflows/code-review.yml`). If a thread the bot addressed is still
   open, reply saying what fixed it and resolve it with hub
   `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<id>"}) { thread { isResolved } } }'`.

The theme behind both checks: on this repository a green required check has
more than once meant "nothing ran" rather than "nothing is wrong". Confirm what
a check actually did before you rely on it.

If it is still red after 4 rounds, stop and hand the remaining findings to the
user rather than merging around them.

## 7. Merge

The user has standing authorization for this step: once all required checks
listed in `docs/operations/required-checks.md` pass, no critical/high/medium
finding is open and every thread is resolved, merge without pausing to ask
again.

```
hub gh api repos/dvdtrsnk/alldots/pulls/<n>/merge --method PUT -f merge_method=merge -f sha=<head>
```

`merge_method=merge`, not squash: `develop`'s history is merge commits
(`Merge pull request #NNN from dvdtrsnk/...`) and the individual commits on the
branch are worth keeping. `sha` is the head you pushed. GitHub refuses the
merge if the head moved in the meantime, so the merge is of exactly what passed
the checks. Merging can only add to `develop`. The repository deletes the head
branch itself after the merge.

Confirm with hub `gh pr view <n> --json state,mergedAt,mergeCommit,baseRefName`
and check that `baseRefName` is `develop`.

If GitHub refuses the merge:

- *"not up to date"* / behind base / head moved → back to §2. Expect this
  whenever a sibling pull request merged while your checks were running: your
  branch was green and is now behind. It costs one merge from `develop` and one
  more pass through §6 — it is not a reason to hand the branch back to the
  user.
- *unresolved conversations* → back to §6.7.
- If Access Hub refuses the call (a permission gate, not a GitHub refusal),
  retry the exact same call once. If it is still refused, stop and tell the
  user — do not route around it.

## 8. Local cleanup

Leave the main checkout as it is (rules above); `git -C <main> fetch --prune`
only refreshes its remote-tracking refs.

- **A bb-managed worktree** (the environment of §0.3): leave it in place. bb
  removes it when the thread is archived. Tell the user the thread can be
  archived now.
- **A worktree you created yourself**: from a directory outside it, run
  ```
  git -C <main> worktree remove <worktree>
  git -C <main> branch --set-upstream-to=origin/develop <branch>
  git -C <main> branch -d <branch>
  ```
  `worktree remove` without `--force` refuses when something uncommitted would
  be lost. Pointing the branch's upstream at `origin/develop` makes `branch -d`
  check the merge against `develop`, because the main checkout's own `develop`
  is not the trunk. If either command refuses, report what is left rather than
  overriding it.

## Report

State the PR URL, how many review rounds ran and what each fixed, anything left
open and why (each mobile step that was NOT RUN, with its reason), the merge
commit SHA on `develop`, and the final state of the worktree and branch. If you
stopped early, say exactly where and what the user must do next.
