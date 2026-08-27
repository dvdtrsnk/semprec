---
name: define-behavior
description: Turn a feature idea into a user-approved behavior specification and a batch of sequential, self-contained GitHub issues (epic + implementation issues) in dvdtrsnk/semprec, finishing with an independent two-agent audit and automatic review:approved labeling. Invoked explicitly as /define-behavior <idea>; supports a dry-run mode.
disable-model-invocation: true
---

# /define-behavior — from idea to approved issue batch

Input: `$ARGUMENTS` — a short statement of the desired behavior. If the first word
is `dry-run`, run every phase normally but write issue drafts to local files
instead of touching GitHub, and skip labeling.

The pipeline this feeds is fully autonomous: once issues get `review:approved`,
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
  discipline — see `backend/review-rules/` and the skills in
  `backend/.claude/skills/`). Do not ask which library, which table layout,
  which endpoint shape. An architecture question is legitimate only when the
  existing architecture genuinely does not answer it — and even then, first send
  a subagent to check.
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
3. Write every issue per `.github/ISSUE_FORMAT.md`: title `[slug NN/MM] …`,
   mandatory `**Blocked by:**` first line (first issue: `none`; every later
   issue: at least its predecessor), Context / Task / Scope (In+Out) /
   Acceptance criteria.
4. Write the epic per the same document: approved spec + checklist.
5. **dry-run:** write epic + issues as separate files into the scratchpad
   directory and stop after Phase 5's audit of those files (no gh calls, no
   labels). Otherwise: create the epic first, then the issues in order
   (`gh issue create -R dvdtrsnk/semprec`), then edit the epic to fill in the
   real issue numbers in its checklist.

## Phase 5 — Independent audit, then arm the pipeline

Spawn **two independent subagents with clean context** (general-purpose, in
parallel). Give each only: the epic number, the list of issue numbers, and the
instruction to read `.github/ISSUE_FORMAT.md` plus the issue bodies from GitHub
(or the draft files in dry-run). Each audits independently:

- **Coverage** — every behavior in the epic spec lands in exactly one issue;
  nothing in any issue lacks a basis in the spec.
- **Self-containment** — no issue depends on unwritten context or external
  documents; an agent reading only the issue could implement it.
- **Blocking graph** — every issue has the Blocked-by line, the chain is
  sequential, no cycles, no issue could be picked up before its real
  prerequisites are closed.
- **Format compliance** — title format, section order, acceptance criteria
  present, English canonical keys.

Compare the two reports:

- **Both clean** → label every implementation issue (NEVER the epic)
  `review:approved`, then tell the user: batch summary, issue numbers, and that
  the VPS dispatcher will pick up the first issue within ~10 minutes.
- **Findings** → fix the issues via `gh issue edit`, then re-audit with fresh
  subagents. Repeat until clean.
- **Unresolvable disagreement or a spec gap** → leave everything unlabeled and
  hand the decision to the user. An unarmed batch is a safe state; a wrongly
  armed one is not.
