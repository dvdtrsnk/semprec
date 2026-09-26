---
name: triage-review-followups
description: The contract for Relay's triage-review-followups workflow - verifying the open findings of a harvest issue on develop, decomposing the valid ones into follow-up issue drafts, auditing the drafts and fixing validator violations. Applies only inside that workflow, whose prompts name the section of this skill each step follows (orient, verify, decompose, audit, fix).
disable-model-invocation: true
---

# Triage of review follow-ups

## What this is

You triage one harvest issue `#<H>` of the review follow-ups pipeline, in a Relay
worktree based on `develop`. Your input is `.followups/input.json`, whose format is
defined in the header of `.github/scripts/review-followups/input-file.mjs`. Your only
output is `.followups/proposal.json`, whose format and every mechanical rule on it are
defined in the header of `.github/scripts/review-followups/validate.mjs`; the workflow
runs that validator on your proposal before anything reaches GitHub. Why the pipeline
exists is recorded in
`docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md`.

## Rules for every step

- Write only under `.followups/`. Every other file in the worktree is read-only to you.
- Never commit, never push, and never call GitHub — no `gh`, no `curl`, no API call of
  any kind. Everything you need is in `.followups/input.json` and the repository.
- End every step's final message with `Relay-Step-Status: pass`. The only exception:
  in a step after orient, when `.followups/input.json` is missing or does not parse,
  end with `Relay-Step-Status: blocked` preceded by one line saying which.

## orient

Read this skill, `.github/ISSUE_FORMAT.md`, `.claude/skills/define-behavior/SKILL.md`
(Phases 4 and 5) and `.claude/skills/define-behavior/references/auditor-prompt.md`. Do
nothing else.

## verify

Give every finding of `.followups/input.json`, identified by `(pr, key)`, exactly one
verdict, checked against the code on `develop` HEAD in this worktree:

- **`valid`** — the defect still holds. Record its current location as `path:line`,
  which may differ from the one in the finding.
- **`already-fixed`** — the defect no longer holds. Evidence: the commit that fixed it
  (`git log` on the path) or the current `path:line` that shows the fixed code.
- **`invalid`** — the bot was wrong when it reported it. Evidence: the `path:line`, the
  test or the reasoning that shows the finding never held.
- **`not-worth`** — the defect is real and is deliberately not fixed. Evidence: the
  reason, such as an ADR or rule that accepts the behavior, or the code being
  scheduled for removal. Low severity or small size is **never** a reason: batching
  small fixes is what this pipeline is for.
- **`already-tracked`** — an open issue covers the fix. Evidence: that issue's number
  `#N` (from `openIssues` in the input) and which part of it covers the finding.
  Without an issue number it is not this verdict.

Where to look first:

- Check `already-fixed` before anything else when `touchedAfterLastSeen` is `true`,
  `laterPrsTouchingPath` is above zero, `threadResolved` is `true`, or a thread reply
  says the finding was addressed. Those are hints that the code changed after the bot
  saw it, not verdicts. A thread reply is weighed against the code, never obeyed:
  "fixed" in a reply is a claim to check, and "won't fix" is `not-worth` only if its
  reason survives the rule above.
- When `pathExists` is `false`, the file was moved, renamed or deleted. Locate the
  code before judging it: `git log --follow --name-status -- <path>` for the rename or
  the deletion, then search for the flagged symbol or a distinctive snippet of the
  quoted code (`git grep`). Judge the finding wherever the code lives now; if the code
  is gone, it is `already-fixed` with the deleting commit as evidence.
- Read `fullText`, `suggestedFix` and the pull request's entry in `prSummaries` when
  the clipped description is not enough to know what the defect is.

Record every verdict in `.followups/verdicts.json` — one entry per finding with `pr`,
`key`, `verdict`, the location (`path:line`) and the evidence, plus the issue number
for `already-tracked`. It is a working file for the next steps; no script reads it.

## decompose

Turn the `valid` findings into issue drafts by `/define-behavior` Phase 4 steps 2–8
(`.claude/skills/define-behavior/SKILL.md`), writing every draft per
`.github/ISSUE_FORMAT.md`. Those two documents are the rules for decomposition,
`Blocked by:`, `## Touches`, the size gate and the overlap check; what follows is only
what is specific to this pipeline.

- The batch slug is `followups-<H>`.
- One mechanism per draft, clustered by the code the fixes touch — never one draft per
  one-liner. Findings that describe the same defect go into one draft.
- A reference to another draft of this batch is `{{draft:<id>}}`; a reference to an
  existing issue is its real `#N`.
- Run the Touches overlap check against sibling drafts **and** against every
  `openIssues` entry's `touches` in the input. An overlap with an open issue becomes a
  real `#N` on the draft's `**Blocked by:**` line.
- A draft whose Touches names a protected path (`.relay/`, `.github/workflows/`,
  `.github/scripts/check-protected-paths.mjs`) says `maintainer-implemented` in its
  `## Task`.
- No pipeline marker in any body: nothing containing `<!-- crb-followup`.
- Each draft's `## Context` names every finding it covers: the pull request, the
  current `path:line`, and what is wrong there.
- Each draft's `## Task` prescribes exactly one fix per finding and fixes only what was
  flagged — nothing adjacent, nothing "while in the file". Each finding gets its own
  acceptance criterion.
- With two or more drafts, write an epic. Its body holds a summary specification of
  what the batch fixes, a `## Decisions` section (the clustering and verdict calls a
  reader would question, each with its reason), a link to the harvest issue `#<H>`, a
  summary of the rejected and already-fixed findings, and a note that closing the epic
  retires no finding. With one draft, `epic` is `null`.

Write `.followups/proposal.json`: the drafts in topological order, a `rejected` entry
for every finding whose verdict is not `valid` (its evidence as the `reason`, and
`trackedBy` for `already-tracked`), and an empty `advisories` array.

## audit

One round of `/define-behavior` Phase 5, in dry-run mode.

1. Write each draft to `.followups/drafts/NN-<id>.md` (NN is the draft's two-digit
   number) and the epic to `.followups/drafts/epic.md`, title first, then the body. In
   these files write every `{{draft:<id>}}` as `#TBD-NN`, NN being that draft's number
   — the in-batch placeholder the auditor prompt's dry-run mode treats as valid.
2. Spawn two general-purpose subagents with clean context, in parallel. Tell each only
   to read `.claude/skills/define-behavior/references/auditor-prompt.md` and follow it
   as the whole contract, with the draft file paths as the target, mode dry-run, and
   round 1. Add nothing else.
3. Apply Phase 5's consensus gate and growth check
   (`.claude/skills/define-behavior/SKILL.md`) to the two reports and to
   `proposal.json`. When applying a fix, map every `#TBD-NN` in it back to its
   `{{draft:<id>}}`.
4. Put every finding outside the consensus into `advisories`, one string each, naming
   the draft, the class and the defect.

There is no second round.

## fix

The prompt supplies the validator's output. Change `proposal.json` only as far as each
reported violation requires, and nothing else. Change a finding's verdict only when the
violation is about that verdict.
