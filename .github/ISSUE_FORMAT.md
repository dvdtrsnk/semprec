# Canonical issue format

Every implementation issue in this repository follows this exact structure. It is
the contract between the planning side (`/define-behavior`) and the execution side
(Relay's `implement-issue` workflow — `.relay/workflows/implement-issue.md` — which
loads `.bb/skills/implement-issue/SKILL.md`, plus the code-review bot): the issue
body is the implementing agent's **only** source of truth, so anything the
implementer needs must be inside it.

## Why these rules exist

- **A dependency DAG, not a chain.** `Blocked by:` names a real dependency only
  — a capability another issue's Task delivers that this one needs, or a
  shared-file overlap that can't be split (see "Touches and conflict hotspots"
  below) — never "the previous issue in the batch" by default. Two issues that
  need nothing from each other and touch disjoint files carry no `Blocked by:`
  relationship between them, are both eligible as soon as their real
  dependencies close, and Relay may implement several of them at once, up to
  `implement-issue`'s `max-concurrent` (`respect-blocked-by: true` in
  `.relay/workflows/implement-issue.md` still enforces every real edge; it no
  longer serializes a whole batch by default). See
  `docs/adr/2026-09-24-issue-batches-as-dependency-dags.md` for why.
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
- `NN/MM` — the issue's position in the batch's **topological creation order**
  (every issue after every issue named on its own `Blocked by:` line) / batch
  size, zero-padded (`03/07`). Not an execution-order promise: two issues with
  no dependency between them may implement in either order, or at the same
  time.
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
- List every issue whose delivered capability this issue's Task genuinely
  needs, plus any real cross-batch dependency. Do **not** add the previous
  issue in the batch by default — that serializes the batch again for no
  reason. The one case that still puts a same-batch issue here without a
  capability dependency is an unavoidable shared-file overlap (see "Touches
  and conflict hotspots" below): when two issues' edits to the same file
  can't be split apart, block the later-numbered one on the earlier.
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
belongs in sibling issues instead.

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

### 4. `## Touches`

```
### Touches
- backend/packages/data/src/mail/mailModuleManifest.ts
- backend/packages/data/src/index.ts (new manifest export line)
```

Every file this issue's Task will create or modify, one per line — a narrow
area within a file (a specific export block, a specific key namespace) where
that is more precise than the whole file. This is what lets decomposition
(`/define-behavior` Phase 4) and the Phase 5 audit catch two
concurrently-eligible issues that would otherwise collide on the same file;
see "Touches and conflict hotspots" below. A file the issue creates counts
too, so a sibling planning to create the same file is caught before either is
dispatched.

### 5. `## Scope`

```
### In scope
### Out of scope
```

Out of scope lists what is deliberately deferred and which issue (if known) picks
it up. The code-review bot treats implementing an out-of-scope item as a finding.

### 6. `## Acceptance criteria`

Observable, testable behaviors — "when X happens, Y is observable". The
implementing agent's self-check and tests are written against these.

## Touches and conflict hotspots

Decomposition (`/define-behavior` Phase 4) checks that no two issues eligible
at the same time — neither transitively `Blocked by:` the other — declare
overlapping `## Touches`. When they do, either add a real `Blocked by:` edge,
or extract the shared change into its own earlier issue that both then
depend on (a registry entry, a shared type, a migration).

Known hotspots and the convention for each:

- **Migration ordinals** — `backend/packages/data/src/db/migrations/NNNN_*.sql`.
  Two branches picking the same next number never conflict in git (different
  filenames) and never fail at the database layer (the runner keys applied
  migrations by full filename) — only `check-migration-numbering` in the
  required `ci` job catches it (#288). Convention: take the next free ordinal
  at commit time, right before pushing, not when the issue is drafted — the
  free ordinal moves as sibling issues merge. On a rebase collision, renumber
  only your own branch's migration file to the next free ordinal; never
  renumber a migration that already merged.
- **Module manifests and registries** —
  `backend/packages/module-registry/src/{manifest,registry,catalog}.ts` and
  each module's own `*ModuleManifest.ts`. Two issues that both add an entry
  to the same manifest array or registry call overlap even though each
  issue's own new file does not. Convention: one issue owns one manifest
  file's edit for a given batch; a batch that needs several modules
  registered puts all of those registrations in one earlier issue, or splits
  them across issues that are genuinely `Blocked by:` each other.
- **Barrel `index.ts` files** — e.g. `backend/packages/data/src/index.ts`,
  `backend/packages/module-registry/src/index.ts`. Every new exported
  module or manifest adds a line here, so two sibling issues touching it in
  the same region collide even when their real code lives in disjoint files.
  Declare the barrel file in `## Touches`; if two concurrently-eligible
  issues both need to add an export there, block the later on the earlier.
- **i18n message catalogs** — `web/src/i18n/cs.json`, `web/src/i18n/en.json`,
  `web/src/i18n/messages.ts`. Same shape as the barrel case: declare these
  files in `## Touches` whenever the Task adds or changes a user-facing
  string, and resolve an overlapping key/namespace between siblings with a
  dependency rather than leaving it to the merge.

A hotspot file appearing in two issues' `## Touches` is not itself a defect —
it only matters when those two issues could be eligible at the same time. An
issue and its own `Blocked by:` dependency touching the same file is normal
and expected.

## Epic issue (one per batch)

```
Title: [<batch-slug>] <Batch name> — epic
```

Body: the user-approved behavior specification and a `## Decisions` section
recording the load-bearing Q&A from the specification interview (question →
adopted answer → reason). The body does **not** list the batch's issues: they
are the epic's GitHub sub-issues, which GitHub renders on the epic with their
live open/closed state. A hand-written list next to them is a duplicate that
nothing updates, so it goes stale as soon as the first issue closes. The epic:

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
`sub_issues_summary` reports every linked sub-issue closed. An epic with no
sub-issues linked is never a candidate. On the run that first finds it complete,
the workflow only announces that in a comment; it closes the epic on a later run
once that announcement is at least `GRACE_HOURS` (default 20) old. Linking a new
sub-issue in between withdraws the announcement and restarts the clock. Labeling
the epic `epic:wip` opts it out of this entirely, for as long as the label is
there — use it for a batch that is deliberately going to stay open. A
normally-decomposed batch needs no one to close its epic by hand.

## Labels

Exactly one `agent:*` / `review:*` state applies to an issue or pull request at a
time; several are park labels that a human must clear before Relay resumes.

| Label | Set by | Meaning |
|---|---|---|
| `spec:approved` | `/define-behavior` Phase 5, or a human approving a `spec:proposed` follow-up issue | Issue's spec passed the batch audit — no blocking finding survived it |
| `agent:ready` | `/define-behavior` Phase 5, alongside `spec:approved`, or a human approving a `spec:proposed` follow-up issue | Queued for Relay's `implement-issue` workflow — this is the label Relay actually dispatches on; `spec:approved` alone dispatches nothing |
| `agent:blocked` | a Relay workflow's `on-blocked` chain (`implement-issue`, `merge-pull-request`, `fix-review-findings`), or a human | Park label: the run stopped deliberately on something only a human can decide. Excluded from every workflow's trigger; on a pull request, `recover-blocked-issue` may pick it up automatically on the same branch. A human resolves the issue and removes the label to let Relay pick it up again |
| `agent:needs-human-action` | Relay (`recover-blocked-issue`'s `on-blocked` chain) | Park label: automatic recovery could not proceed without an action no worker credential can perform. A human takes that action, then removes the label |
| `relay:needs-human-action` | Relay (`merge-pull-request`'s and `fix-review-findings`'s `on-failure` chains) | Park label: a run failed outright (not a deliberate block). A human reads the failure comment, fixes the cause, and removes the label — or pushes a new head, which also clears it |
| `review:ready` | Relay (`implement-issue`, `fix-review-findings`, `recover-blocked-issue`) | Pull request is ready for `review-pull-request` to run the code-review bot |
| `review:in-progress` | Relay (`review-pull-request`'s `claim` step) | The bot is running now |
| `review:passed` | Relay (`review-pull-request`) | No blocking finding; `merge-pull-request` picks the pull request up next |
| `review:changes-requested` | Relay (`review-pull-request`'s `on-failure` chain) | A blocking finding; `fix-review-findings` picks the pull request up next |
| `epic:wip` | a human | Opts an epic out of `close-completed-epics`, even once every sub-issue is closed |
| `followups:harvested` | the harvest | On a merged pull request whose open findings were harvested, or that had none |
| `followups:harvest` | the harvest | On every harvest issue; kept forever |
| `followups:ready` | the harvest | On a harvest issue awaiting triage; Relay's trigger; removed by triage when it publishes |
| `followups:issue` | triage | On every issue and epic it creates; kept forever |
| `spec:proposed` | triage | On every issue it creates; awaiting human approval; never dispatched |

`agent:ready` is not a label an issue keeps once it's done: `merge-pull-request`'s
`dequeue` step removes `agent:ready` (and `agent:blocked`) from the linked issue
once its pull request merges, so a lagging issue listing can't dispatch it a
second time.

A follow-up issue created by triage waits under `spec:proposed` for a human
decision. Approving it means swapping `spec:proposed` for `spec:approved` +
`agent:ready`; an issue touching a protected path gets `spec:approved` only and
is maintainer-implemented. To reshape it, a human edits the issue, then approves
it. Closing a proposed issue rejects it and retires its findings permanently,
because their markers stay in the ledger whatever the issue's state; reopening it
is the undo. Closing an epic decides nothing: each child issue carries its own
findings and its own decision. See
[`docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md`](../docs/adr/2026-09-26-merged-review-findings-become-proposed-follow-up-issues.md).

## Hand-over context

An issue's `Blocked by:` line names the issues its implementer needs context
from. That context is not a comment on the blocker: `merge-pull-request` leaves
only a short run-log comment there ("Resolved by #N, merged into develop"). The
actual hand-over — what was implemented, notes for what comes next — is the
**pull request description** of the PR that closed the blocker:
`gh issue view <blocker> --json closedByPullRequestsReferences`, then read that
pull request's body.
