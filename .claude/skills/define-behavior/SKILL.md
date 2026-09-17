---
name: define-behavior
description: Turn a feature idea into a user-approved behavior specification and a batch of sequential, self-contained GitHub issues (epic + implementation issues) in dvdtrsnk/semprec, finishing with a bounded, consensus-gated two-agent audit and automatic spec:approved labeling. Invoked explicitly as /define-behavior <idea>; supports a dry-run mode.
disable-model-invocation: true
---

# /define-behavior — from idea to approved issue batch

Input: `$ARGUMENTS` — a short statement of the desired behavior. Two prefixes
change the run:

- `dry-run` — run every phase normally but write issue drafts to local files
  instead of touching GitHub, and skip labeling.
- `audit #N` — audit issue `#N`, which already exists and was written by hand.
  Skip Phases 1–4 entirely and start at Phase 5, per "Auditing an issue this
  skill did not create" below. This skill is not model-invocable, so a bare
  request to review an issue does not reach it: run it as
  `/define-behavior audit #N`. On its own, `audit #N` is a real-mode run: it
  edits the live issue through the consensus gate and labels it at the end.

The two compose as `dry-run audit #N`, which reads the live issue and writes
nothing at all — no edit, no label. There are no draft files to edit in this
combination, so report the findings and the edits you would have made instead.

The pipeline this feeds is fully autonomous: once issues get `spec:approved`,
a headless agent on the VPS implements them one by one with **no human in the
loop**, reading nothing but the issue bodies. That is why this skill is
deliberately slow and thorough up front — every ambiguity you leave in an issue
becomes a wrong guess made by an unsupervised agent at 3 a.m.

Converse with the user in the language they use. Everything written to GitHub is
English. The issue structure contract is `.github/ISSUE_FORMAT.md` — read it
before Phase 4 and follow it exactly.

## Phase 1 — Recon (subagents, keep it cheap)

Before asking the user anything, learn what already exists. Spawn 1–3 `Explore`
subagents in parallel (only as many as the idea genuinely spans — one for a
contained feature):

- What parts of the codebase does this behavior touch? What patterns already
  exist there (choke-point endpoints, view types, heartbeats, modules)?
- Which existing issues (open or closed) overlap or border this idea?
  (`gh issue list -R dvdtrsnk/semprec --state all`)

Their findings shape your questions and later the decomposition. Do not skip
this: a question the codebase can answer must never be asked to the user.

## Phase 2 — Grilling (relentless, behavior only)

Interview the user about the **behavior** until the decision tree is exhausted —
one question at a time, each with your recommended answer. Walk every branch:
normal flow, edge cases, empty/error states, who is allowed to do what, what the
user sees, what happens on failure, what is deliberately NOT included.

Hard rules:

- **Behavior, not technology.** The architecture is already fixed by this
  project (choke-point API, ownership model, module contracts, migration
  discipline — see `backend/review-rules/`, the skills in
  `.bb/skills/`, and the decisions recorded under `docs/adr/`).
  Do not ask which library, which table layout, which endpoint shape. An
  architecture question is legitimate only when the existing architecture
  genuinely does not answer it — and even then, first send a subagent to check
  both the review-rules/skills and `docs/adr/`.
- **One question per message**, with a recommendation and its reasoning. Batched
  questionnaires get shallow answers.
- **Persist.** Do not stop at the first "sounds good". You are done only when no
  branch of the behavior remains unresolved. If the user answers "whatever you
  think", record your recommendation as the decision and move on.
- If a question can be answered by exploring the codebase, explore the codebase
  instead of asking.

## Phase 3 — Specification approval (the gate)

Write a compact behavior specification: numbered behaviors, edge-case decisions,
explicit out-of-scope list. Present it and ask for explicit approval.

After approval, **creativity ends**. Phases 4–5 are mechanical: no new behaviors,
no reinterpretation, no "while I'm at it". If decomposition reveals a genuine gap
in the spec, go back to the user — do not fill it silently.

## Phase 4 — Decomposition and creation

1. Choose a short kebab-case batch slug.
2. Decompose the spec into a **strictly sequential** chain of issues. Each issue
   must be implementable by an agent that reads only that issue (plus comments on
   its blockers). Inline everything it needs — copy context in, do not point
   elsewhere. Size guide: one issue = one coherent PR an agent finishes in a
   single run.
3. Write every issue per `.github/ISSUE_FORMAT.md` — that document is the
   authority on the Blocked-by rules (in short: `none` only for a batch with no
   dependencies at all; a dependent batch's first issue lists its real
   cross-batch blockers; every later issue lists at least its in-batch
   predecessor). When citing a cross-batch blocker, verify (recon findings or a
   quick look at the issue) that the cited issue actually *delivers* the needed
   capability — if unsure, block on the latest issue known to already use it.
4. Avoid forward references: an issue's Context may point to its predecessors
   freely, but reference a *later* sibling only when genuinely needed.
5. If decomposition genuinely requires a new architectural decision (not
   covered by an existing rule or `docs/adr/` record — this should be rare per
   "Behavior, not technology" above), name it explicitly in the Task of the
   issue that introduces it: that issue must add an ADR under `docs/adr/`
   (format in `docs/adr/README.md`) alongside the implementation.
6. Write the epic per the same document: approved spec, a `## Decisions` section
   preserving the grilling Q&A (question → adopted answer → reason — the
   decision log would otherwise die with this conversation), and the checklist.
7. **Real mode:** create the epic first, then the issues **in batch order**
   (`gh issue create -R dvdtrsnk/semprec`) — creating sequentially means every
   backward in-batch reference already has its real `#N` at write time. Then do
   one substitution pass: edit the epic checklist and any issue that used a
   forward reference, replacing placeholders with real numbers. No `#TBD` may
   survive — the dispatcher only parses `#N`.
   **dry-run:** write epic + issues as separate files into the scratchpad
   directory, using `#TBD-NN` for in-batch references (real cross-batch
   blockers keep their real `#N`). No gh calls, no labels.

## Phase 5 — Bounded audit, then arm the pipeline

The audit is **two rounds at most**, and what gets fixed is decided by agreement
between the auditors, not by whether a finding was raised at all.

This is not a cost compromise — an unbounded audit is *worse*, not just slower.
Every fix lengthens the issue, and a longer issue offers more surface to the next
round, so the loop generates defects as fast as it removes them: renumbered steps
that leave stale references, a rule number that reads as an issue number, a
paragraph added to answer a critique of a paragraph. A specification that is
right and dispatched beats one that is perfect and still unlabeled.

### Round 1

Record each issue's body length first — you need it for the growth check below.

Spawn **two independent subagents with clean context** (general-purpose, in
parallel). Give each the same short instruction, and nothing improvised on top of
it: read `.claude/skills/define-behavior/references/auditor-prompt.md` and follow
it as the whole contract; the audit target (epic number and issue numbers, or the
draft file paths in dry-run); the mode; and the round number. That file is the
calibration — do not restate, summarise or extend it in the spawn prompt, or the
two auditors stop being comparable.

### The consensus gate

Compare the two reports finding by finding. Two findings are **the same finding**
when they name the same issue and point at the same defect — judge that by
substance, not by string equality. Any one of these settles it: their `quote`
spans overlapping text, their `proof` cites the same command or `path:line`, or
their `fix` would produce the same edit. Auditors writing independently almost
never quote a defect identically, so an exact-match rule would collapse the gate
into "the driver decides" and waste the second auditor entirely. **When you cannot
tell whether two findings are the same defect, treat them as matching** — the fix
is the smallest edit that removes it either way, so the cost of pairing them
wrongly is far below the cost of missing a real agreement.

Edit an issue only for a finding that is either:

- **reported by both auditors**, or
- **reported by one and carries a proof you verified yourself** — you ran the
  command and it failed, or you read the `path:line` and it says what the auditor
  claims. A proof you did not check does not count.

Every other finding — raised once, unproven — goes into your report to the user
and **nowhere near the issue body**. This is what the second auditor is for: the
signal is in the overlap, not in the union.

Apply the `fix` field as written: the smallest edit that removes the finding. Do
not rewrite a section to answer a finding, and do not fix an advisory finding by
adding prose that explains itself.

**Growth check.** Run this per issue, after that issue's fixes. Length means
characters, counted the same way before and after: `gh issue view <N> --json body
--jq '.body | length'` in real mode, `wc -m` on the draft file in dry-run. An
issue over 1.5× its pre-audit character count is being healed with prose, which is
the failure this phase is bounded to prevent.

The check is per issue and so is the halt: stop applying fixes to **that** issue
and go on fixing the others. One bloated issue in a batch of eight says nothing
about the other seven.

For the halted issue, choose by where the growth came from, not by judgement. If
deleting text **you** added during this audit brings it back under the threshold,
delete it and the issue rejoins the run — that is mechanical and needs no one's
permission. If getting back under would mean cutting text the issue already had
before the audit, leave it as it is and hand **it** to the user: shortening what
the user approved in Phase 3 edits the specification rather than repairing it.
The rest of the batch continues to round 2 and its terminal state without it, and
an issue handed over this way is never labeled.

### Round 2 — narrow

**If the gate produced no edits, skip round 2 entirely** and go to the terminal
states. Round 2 exists to check your fixes; with no fixes there is nothing to
check, and re-auditing an untouched body is exactly the re-litigation this phase
is bounded to prevent.

Otherwise spawn two fresh auditors with the same prompt file, round number 2. Give
them the diff of your fixes and the findings those fixes claim to close — **not**
the full bodies again. They answer only whether each fix closed its finding and
whether it broke something else.

Apply the consensus gate again. Then stop: there is no round 3.

### Terminal states

- **No blocking finding survives round 2, real mode** → label every implementation
  issue (NEVER the epic) `spec:approved`. Open advisory findings do not hold the
  label back; list them to the user instead, so they can decide. Report: batch
  summary, issue numbers, the advisory findings left on the table, and that the
  VPS dispatcher will pick up the first issue within ~10 minutes.
- **No blocking finding survives round 2, dry-run** → report the summary, the file
  paths and the advisory findings; no labeling.
- **A blocking finding passes the gate in round 2** → if its `fix` is a single
  mechanical edit (a name, a number, a reference), apply it and then finish in
  whichever of the two terminal states above matches your mode — labeling in real
  mode, reporting without labels in dry-run — without a third round to confirm
  the edit. Dry-run never labels, in this state or any other. If the fix is
  anything larger than a single mechanical edit, leave
  everything unlabeled and hand it to the user with the finding and its proof.
  Round 2 has then found either a real defect your fix missed or a defect your fix
  created, and both are decisions worth a human; a third round is how this phase
  used to spend forty minutes and still arm nothing.
- **A finding that is actually a spec gap** → back to the user, per Phase 3. Do not
  decide it here.

An unarmed batch is a safe state; a wrongly armed one is not.

## Auditing an issue this skill did not create

`/define-behavior audit #N` — the user asking for an existing hand-written issue
to be armed — runs Phase 5 and nothing else: same prompt file, same two auditors,
same consensus gate, same two-round bound, same terminal states. Judge coverage
against the issue's own Context and Task rather than an epic spec, and tell the
auditors there is deliberately no epic. Do not improvise a fresh audit prompt for these; the
whole point of the prompt file is that the bar does not move between runs.
