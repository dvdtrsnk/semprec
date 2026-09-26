---
id: triage-review-followups
name: Triage review follow-ups
priority: 30   # below the review/merge/fix flows, which finish work already in flight, and above implement-issue (20), so a pending harvest does not starve behind new implementations
max-concurrent: 1
on:
  issues:
    label: followups:ready
    exclude-labels: [agent:blocked, agent:needs-human-action]
    respect-blocked-by: false          # a harvest issue's findings may contain "blocked by", which would hold the issue on an unrelated number
    skip-if-open-pull-request: false   # triage opens no pull request, so there is no duplicate to guard against
# Integrity check, repeated at the head of every deterministic step: the agent steps can
# edit any file of the worktree, so each such step refuses to run unless
# .github/scripts/review-followups/ is exactly the develop fork point's copy — no
# committed, staged, unstaged or untracked difference.
steps:
  - id: pickup
    uses: comment
    body: "Relay picked up this harvest issue for triage."
  - id: orient                         # the first agent step creates the worktree prepare writes into
    uses: agent
    prompt: "#orient"
  - id: integrity
    uses: command
    run: "b=$(git merge-base HEAD origin/develop) && git diff --quiet \"$b\" -- .github/scripts/review-followups && test -z \"$(git ls-files --others -- .github/scripts/review-followups)\" || { echo 'integrity: .github/scripts/review-followups differs from the develop fork point'; exit 1; }"
    on-failure: blocked
  - id: prepare
    uses: command
    github-api: true
    run: "{ b=$(git merge-base HEAD origin/develop) && git diff --quiet \"$b\" -- .github/scripts/review-followups && test -z \"$(git ls-files --others -- .github/scripts/review-followups)\" || { echo 'integrity: .github/scripts/review-followups differs from the develop fork point'; exit 1; }; } && node .github/scripts/review-followups/prepare.mjs --harvest-issue {{issueNumber}} --out .followups"
  - id: verify
    uses: agent
    prompt: "#verify"
  - id: decompose
    uses: agent
    prompt: "#decompose"
  - id: audit
    uses: agent
    prompt: "#audit"
  - id: validate
    uses: command
    run: "{ b=$(git merge-base HEAD origin/develop) && git diff --quiet \"$b\" -- .github/scripts/review-followups && test -z \"$(git ls-files --others -- .github/scripts/review-followups)\" || { echo 'integrity: .github/scripts/review-followups differs from the develop fork point'; exit 1; }; } && node .github/scripts/review-followups/validate.mjs --input .followups/input.json --proposal .followups/proposal.json"
    on-failure: { goto: fix }
  - id: publish
    uses: command
    github-api: true
    run: "{ b=$(git merge-base HEAD origin/develop) && git diff --quiet \"$b\" -- .github/scripts/review-followups && test -z \"$(git ls-files --others -- .github/scripts/review-followups)\" || { echo 'integrity: .github/scripts/review-followups differs from the develop fork point'; exit 1; }; } && node .github/scripts/review-followups/publish.mjs --input .followups/input.json --proposal .followups/proposal.json"
    on-failure: blocked
    on-success: end
  # Relay turns a spent max-rounds budget after a failing command into a failed run
  # (retried from scratch), not a blocked one, so the fix loop is unrolled: two fix
  # rounds, and a third failing validation ends the run blocked.
  - id: fix
    uses: agent
    prompt: "#fix"
  - id: validate-2
    uses: command
    run: "{ b=$(git merge-base HEAD origin/develop) && git diff --quiet \"$b\" -- .github/scripts/review-followups && test -z \"$(git ls-files --others -- .github/scripts/review-followups)\" || { echo 'integrity: .github/scripts/review-followups differs from the develop fork point'; exit 1; }; } && node .github/scripts/review-followups/validate.mjs --input .followups/input.json --proposal .followups/proposal.json"
    on-success: { goto: publish }
    on-failure: { goto: fix-2 }
  - id: fix-2
    uses: agent
    prompt: "#fix-2"
  - id: validate-3
    uses: command
    run: "{ b=$(git merge-base HEAD origin/develop) && git diff --quiet \"$b\" -- .github/scripts/review-followups && test -z \"$(git ls-files --others -- .github/scripts/review-followups)\" || { echo 'integrity: .github/scripts/review-followups differs from the develop fork point'; exit 1; }; } && node .github/scripts/review-followups/validate.mjs --input .followups/input.json --proposal .followups/proposal.json"
    on-success: { goto: publish }
    on-failure: blocked
on-failure:
  - { uses: comment, body: "Relay's triage run failed; Relay retries it after a back-off.{{errorLine}}" }
on-blocked:
  - { uses: labels, add: [agent:blocked] }
  - { uses: comment, body: "Relay's triage run is blocked and will not be retried automatically.{{errorLine}}\n\nRemove the `agent:blocked` label from this issue once the cause is addressed to re-run triage. A re-run prepares its input again from GitHub, so it never re-proposes a finding that is already published." }
---

## What this workflow does

Triages one harvest issue of the review follow-ups pipeline
(`docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md`):
an open issue labelled `followups:ready`, created by the daily harvest, whose
findings become proposed follow-up issues (`followups:issue` + `spec:proposed`,
under an epic when there are two or more) or reasoned rejections. The agent steps
follow `.claude/skills/triage-review-followups/SKILL.md`, write only
`.followups/proposal.json` and working files, and never touch GitHub; only the
deterministic `prepare` and `publish` steps do, through Relay's GitHub proxy
(`github-api: true`), as `bb-agent-relay[bot]`.

- `pickup` leaves a pickup note on the harvest issue.
- `orient` has the agent read the skill and the issue-writing rules. It exists
  because a command step before the first agent step runs in a throwaway checkout
  that is removed when the step ends: the first agent step is what creates the
  worktree `prepare` writes into and every later step reads.
- `integrity` checks that `.github/scripts/review-followups/` is still the develop
  fork point's copy before anything runs it; a difference blocks the run. `prepare`,
  every `validate` and `publish` repeat the check before their script, because an
  agent step may run in between.
- `prepare` writes `.followups/input.json` from the harvest issue, leaving out every
  finding an earlier attempt already published.
- `verify` gives every finding a verdict against `develop`; `decompose` turns the
  valid ones into issue drafts and writes the proposal; `audit` runs one dry-run
  audit round over the drafts.
- `validate` checks the proposal offline. A failure goes to `fix` and `validate-2`,
  a second one to `fix-2` and `validate-3`, and a third ends the run blocked.
- `publish` creates the epic and the issues, posts the triage-result comment,
  removes `followups:ready` and closes the harvest issue. A failure blocks the run
  instead of retrying it.

## prompt: orient

Follow the `orient` section of `.claude/skills/triage-review-followups/SKILL.md`.

## prompt: verify

Follow the `verify` section of `.claude/skills/triage-review-followups/SKILL.md`.

## prompt: decompose

Follow the `decompose` section of `.claude/skills/triage-review-followups/SKILL.md`.

## prompt: audit

Follow the `audit` section of `.claude/skills/triage-review-followups/SKILL.md`.

## prompt: fix

Follow the `fix` section of `.claude/skills/triage-review-followups/SKILL.md`. The validator's output:

```
{{steps.validate.outputTail}}
```

## prompt: fix-2

Follow the `fix` section of `.claude/skills/triage-review-followups/SKILL.md`. The validator's output:

```
{{steps.validate-2.outputTail}}
```
