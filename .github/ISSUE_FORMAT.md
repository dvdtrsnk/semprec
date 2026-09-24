# Canonical issue format

Every implementation issue in this repository follows this exact structure. It is
the contract between the planning side (`/define-behavior`) and the execution side
(Relay's `implement-issue` workflow — `.relay/workflows/implement-issue.md` — which
loads `.bb/skills/implement-issue/SKILL.md`, plus the code-review bot): the issue
body is the implementing agent's **only** source of truth, so anything the
implementer needs must be inside it.

## Why these rules exist

- **Strictly sequential batches.** Issues in a batch are executed one at a time, in
  the order their `Blocked by:` chain enforces — no issue in a batch is eligible
  until its in-batch predecessor has merged and closed
  (`respect-blocked-by: true` in `.relay/workflows/implement-issue.md`). Relay may
  run other, unrelated issues at the same time — `implement-issue`'s
  `max-concurrent: 2` — but nothing inside one batch's own chain ever runs out of
  order or in parallel with itself.
- **Fully self-contained.** The implementing agent reads the issue body and, for
  each issue named in its `Blocked by:` line, the pull request that closed it (see
  "Hand-over context" below) — nothing else. Referencing an external specification
  ("see section 13 of the spec") is a defect: specs drift, issues are the source of
  truth. An issue may reference **other issues** (`#NN`) only.
- **Machine-parseable blocking.** Relay decides "is this issue ready?" by parsing
  the **first** line in the body that contains the words "blocked by" and treating
  every `#N` on that line as a blocker (bb-plugin-relay's
  `src/domain/blockers.ts`). A missing or malformed line, or any mention of
  "blocked by" earlier in the body than the real one, silently breaks ordering.

## Title

```
[<batch-slug> NN/MM] Imperative summary in English
```

- `batch-slug` — short kebab-case identifier of the batch (e.g. `inbox-v2`).
- `NN/MM` — position in the batch / batch size, zero-padded (`03/07`).
- Historical note: the founding batch #21–#41+#50 uses plain `[NN/22]` without a
  slug; do not rename it.

## Body sections (in this order)

### 1. Blocked-by line (mandatory, first line)

```
**Blocked by:** #24, #26
```

or, for the first issue of an independent batch:

```
**Blocked by:** none
```

Rules:
- Every issue has this line. "I forgot" is not a state Relay can parse.
- Each issue after the first lists **at least the previous issue in its batch**;
  add any real cross-batch dependencies on top.
- Relay's parser matches the words "blocked by" (case-insensitive) **only once**
  — the first occurrence in the body — and extracts every `#N` on that one line as
  a blocker. Keep all blocker references on this one line, and never let the words
  "blocked by" appear anywhere earlier in the body (in `## Context`, for instance):
  whichever mention comes first is the one the parser reads, so an earlier,
  unrelated one silently steals the line and every real blocker on it is ignored.
- A cited blocker that 404s when Relay looks it up is treated as **not** blocking
  (dropped silently); any other lookup failure (rate limit, a 5xx from GitHub) is
  treated as **still** blocking. Never cite an issue you expect to be deleted,
  transferred or otherwise made unreachable.

### 2. `## Context`

Why this issue exists, what earlier issues it builds on, what later issues build
on it. References to other issues only — no external documents.

### 3. `## Task`

The exact deliverables. This is the law for the implementing agent: everything
listed here must be delivered, nothing beyond it may be built. Concrete names
(endpoints, tables, keys, view types) belong here, written out — canonical stored
keys are English camelCase, view types kebab-case, user-facing labels via i18n.

**One issue implements exactly one mechanism.** A bundled issue forces one PR
to carry every bundled mechanism's review surface at once, so a finding on any
one of them blocks the whole PR and the fix-review loop repeats for all of
them together: PR #418 (reconnect backoff plus four separate per-stream
recovery paths in one issue) took 10 review rounds and PR #410 (four
independent server-side mechanisms in one issue) took 12, against 0-4 rounds
for single-mechanism PRs #415, #420 and #421. Several bullets are fine when
they are steps of the same mechanism (the migration, the endpoint that uses
it, the client call that hits it) — they are not fine when they enumerate
separable mechanisms ("X, Y, and Z") that don't need each other's code to
exist or to be tested. Mechanical test: could a reviewer approve the first
bullet without having read the third? If yes, this is more than one issue and
belongs in sequential siblings instead.

**Protected paths.** If the Task would touch a path under `.relay/config.yml`'s
`protected-paths` (`.relay/**`, `.github/workflows/**`,
`.github/scripts/check-protected-paths.mjs`) or change branch protection (an
admin-only action), say so explicitly and note that it is maintainer-implemented,
not dispatched to Relay — see Labels below. Relay's own `guard-paths` step blocks
a run that touches one of these paths regardless (and `merge-pull-request`
separately waits on GitHub's `protected-paths` check before merging — see
`docs/operations/required-checks.md`), but an issue armed with `agent:ready`
anyway just burns a run before failing: issues #249, #250 and #188 were entirely
CI-workflow changes and each blocked Relay this way.

### 4. `## Scope`

```
### In scope
### Out of scope
```

Out of scope lists what is deliberately deferred and which issue (if known) picks
it up. The code-review bot treats implementing an out-of-scope item as a finding.

### 5. `## Acceptance criteria`

Observable, testable behaviors — "when X happens, Y is observable". The
implementing agent's self-check and tests are written against these.

## Epic issue (one per batch)

```
Title: [<batch-slug>] <Batch name> — epic
```

Body: the user-approved behavior specification, a `## Decisions` section
recording the load-bearing Q&A from the specification interview (question →
adopted answer → reason), and a checklist of the batch's issues
(`- [ ] #NN — title`). The checklist is for human readers only — nothing
consults it to decide whether the epic is done; see "Closing" below. The epic:

- is **never** labeled `spec:approved` or `agent:ready` (it is not implementable
  work and Relay must never pick it up),
- does not appear in any `Blocked by:` line,
- gets every implementation issue linked to it as a GitHub sub-issue as soon as
  that issue is created:
  `gh api -X POST repos/dvdtrsnk/semprec/issues/<epic-number>/sub_issues -F sub_issue_id=<child-id>`
  — `<child-id>` is the child issue's numeric `id`, not its issue number; get it
  with `gh api repos/dvdtrsnk/semprec/issues/<n> --jq .id`.

### Closing

`.github/workflows/close-completed-epics.yml` runs daily
(`.github/scripts/close-completed-epics.mjs`) and closes an epic once GitHub's own
`sub_issues_summary` reports every linked sub-issue closed — never by reading the
checklist above, which may be stale. An epic with no sub-issues linked is never a
candidate. On the run that first finds it complete, the workflow only announces
that in a comment; it closes the epic on a later run once that announcement is at
least `GRACE_HOURS` (default 20) old. Linking a new sub-issue in between withdraws
the announcement and restarts the clock. Labeling the epic `epic:wip` opts it out
of this entirely, for as long as the label is there — use it for a batch that is
deliberately going to stay open. A normally-decomposed batch needs no one to close
its epic by hand.

## Labels

Exactly one `agent:*` / `review:*` state applies to an issue or pull request at a
time; several are park labels that a human must clear before Relay resumes.

| Label | Set by | Meaning |
|---|---|---|
| `spec:approved` | `/define-behavior` Phase 5 | Issue's spec passed the batch audit — no blocking finding survived it |
| `agent:ready` | `/define-behavior` Phase 5, alongside `spec:approved` | Queued for Relay's `implement-issue` workflow — this is the label Relay actually dispatches on; `spec:approved` alone dispatches nothing |
| `agent:blocked` | a Relay workflow's `on-blocked` chain (`implement-issue`, `merge-pull-request`, `fix-review-findings`), or a human | Park label: the run stopped deliberately on something only a human can decide. Excluded from every workflow's trigger; on a pull request, `recover-blocked-issue` may pick it up automatically on the same branch. A human resolves the issue and removes the label to let Relay pick it up again |
| `agent:needs-human-action` | Relay (`recover-blocked-issue`'s `on-blocked` chain) | Park label: automatic recovery could not proceed without an action no worker credential can perform. A human takes that action, then removes the label |
| `relay:needs-human-action` | Relay (`merge-pull-request`'s and `fix-review-findings`'s `on-failure` chains) | Park label: a run failed outright (not a deliberate block). A human reads the failure comment, fixes the cause, and removes the label — or pushes a new head, which also clears it |
| `review:ready` | Relay (`implement-issue`, `fix-review-findings`, `recover-blocked-issue`) | Pull request is ready for `review-pull-request` to run the code-review bot |
| `review:in-progress` | Relay (`review-pull-request`'s `claim` step) | The bot is running now |
| `review:passed` | Relay (`review-pull-request`) | No blocking finding; `merge-pull-request` picks the pull request up next |
| `review:changes-requested` | Relay (`review-pull-request`'s `on-failure` chain) | A blocking finding; `fix-review-findings` picks the pull request up next |
| `epic:wip` | a human | Opts an epic out of `close-completed-epics`, even once every sub-issue is closed |

`agent:ready` is not a label an issue keeps once it's done: `merge-pull-request`'s
`dequeue` step removes `agent:ready` (and `agent:blocked`) from the linked issue
once its pull request merges, so a lagging issue listing can't dispatch it a
second time.

## Hand-over context

An issue's `Blocked by:` line names the issues its implementer needs context
from. That context is not a comment on the blocker: `merge-pull-request` leaves
only a short run-log comment there ("Resolved by #N, merged into develop"). The
actual hand-over — what was implemented, notes for what comes next — is the
**pull request description** of the PR that closed the blocker:
`gh issue view <blocker> --json closedByPullRequestsReferences`, then read that
pull request's body.
