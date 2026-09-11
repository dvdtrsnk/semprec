---
name: implement-issue
description: The execution contract for implementing one Semprec issue end to end — read the issue, check the ADRs, build exactly the Task, self-review the diff against the platform's review-rules, and verify locally before pushing. Use this at the start of any issue-driven change in this repository, whether dispatched automatically or started by hand.
---

# Implementing one issue

The issue body is your source of truth. It is written to be self-contained:
everything you need is in it, plus the comments on the issues named in its
`Blocked by:` line (those carry merge SHAs and hand-over notes from the work
this one builds on).

## 1. Read before you write

Read the whole issue — `## Context`, `## Task`, `## Scope`, `## Acceptance
criteria` — before touching a file. Then, for anything that is not a straight
application of an existing convention, check `docs/adr/` (`ls docs/adr/`, grep
the `area` frontmatter). Contradicting a recorded decision by accident is
expensive; finding it takes seconds.

For a large or unfamiliar area, map the relevant code before editing. A wrong
first attempt costs more than the reading would have.

## 2. Load the skills this Task touches

Do this before you write anything, and say in one line which you loaded and why
— or that none apply. It is a deliberate decision, not a formality: the rules
below are the ones this repository's review actually reports, and an agent that
means to "remember them as it goes" reliably does not.

| Load | When the Task involves |
|---|---|
| `state-writes` | creating, updating or deleting persisted state — items, relations, blocks, rows in any table |
| `io-hardening` | a new HTTP route or handler, a webhook receiver, or any outbound call |
| `error-handling` | a `catch`, an error mapping, a rollback path, or any decision about what happens on failure |
| `db-migrations` | a schema change, constraint, index, or backfill |
| `canonical-keys` | a stored key, option value, view type, or any string a user will see |
| `ai-gateway` | any model call, provider SDK, or provider credential |
| `adr-conventions` | adding an ADR, or editing, superseding or narrowing an existing one |

Most issues match more than one. Load all that apply — they are short, and the
cost of reading one is far below the cost of the finding it prevents.

## 3. Build exactly the Task

Everything in `## Task` must be delivered. Nothing under `### Out of scope` may
be built, even when it is two lines and you are already in the file — the
out-of-scope list usually names the issue that picks it up, and building it
early creates a conflict with that issue rather than saving it work.

The same restraint applies to things nobody asked for: a config flag "for
later", an exported helper with one caller, an interface field a future issue
might use, a type alias anticipating a union that does not exist yet. Each of
those is a finding, recorded as such in
`docs/adr/2026-09-10-no-speculative-generality-beyond-issue-scope.md`.

The conventions are law, not suggestions: choke-point writes, single-writer
ownership, expand/contract migrations, AI calls only through the gateway,
English camelCase canonical keys, labels through i18n, typed boundaries. You
loaded the skills covering them in step 2 — apply what they say rather than
reconstructing a rule from memory.

Commit as soon as the work reaches a self-consistent state, and again after
each round of fixes. Uncommitted work does not survive a run that ends early.

## 4. Self-review, then verify

In this order, because each step is cheaper than the one after it:

1. **Read your own diff** (`git diff origin/develop`) in the role of a strict
   reviewer applying `review-rules/rules.md` and `review-rules/tasks/*.md` of
   every platform the diff touches. Ask specifically: does anything cross a
   boundary untyped? does any `catch` swallow or re-label an error it did not
   cause? does any new route or outbound call lack auth, a timeout, or a size
   cap? does any docstring claim something the code does not do? is there a
   branch the Acceptance criteria promises and no test covers?
2. **Sweep for leftovers** — debug prints, commented-out code, files unrelated
   to this issue.
3. **Run the pipeline**: `pnpm run verify` in `backend/`, then in `web/`. This
   is the same sequence CI runs, in the same order.

Fix what each step finds and commit it before moving on.

## 5. When the review bot comes back

Findings at `medium` and above block the merge. Triage each one against the
`review-rules/` of the platform it touches:

- **Right** → fix it, re-run the verification for what you touched, commit, push.
- **Cheap and clearly right, but `low`** → fix it.
- **Wrong** → reply on the thread with the concrete reason. Do not edit correct
  code to make a mistaken finding go away; the next reader inherits both the
  change and the confusion.

## 6. When you cannot finish

Do not merge a broken pull request and do not close the issue. Commit and push
what you have so a human can inspect or resume it, then say precisely what
stopped you and what decision is needed. An issue left open is a correct
outcome — a pipeline that halts for attention is working as designed.
