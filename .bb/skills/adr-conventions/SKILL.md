---
name: adr-conventions
description: "When a decision needs an Architecture Decision Record, and the append-only rules for writing, superseding or narrowing one. Load this BEFORE introducing a pattern that no existing ADR and no review-rules/ line covers - deciding it silently is the exact failure this convention exists to prevent, and it is this repository's most repeated review finding. Triggers on: docs/adr/, any file you are about to add or edit there, a new cross-cutting mechanism, a new package, a traversal or protocol or lifecycle contract documented only in code comments, and any wish to reverse or carve an exception into an accepted decision. Skip only when an existing ADR or rule already covers the pattern."
---

# ADRs: append-only, superseded not edited

Full format reference: `docs/adr/README.md`. This skill is the "do I need one, and how do I not break the old ones" checklist.

## When to write one

Write an ADR for a decision that shapes how future code gets written and had a
real alternative (a choke-point vs. direct writes, one AI-provider gateway vs.
per-caller SDK usage, expand/contract migrations vs. in-place changes). Don't
write one for a plain hygiene rule with no real alternative (never log
secrets, sanitize HTML) — those belong in `review-rules/rules.md` as rules,
not decisions.

A genuinely new architectural pattern with no existing ADR or review-rule
covering it needs its ADR in the **same PR** that introduces the pattern, not
a follow-up. `ls docs/adr/` and grep the `area` frontmatter first — a past
decision may already cover it, for or against, before you write a new one.

## The rule that's easy to get backwards: never edit an accepted ADR's body

An ADR's Context/Decision/Consequences is a historical record of what was
decided and why, *at the time*. Once `status: accepted`, that text is frozen —
even a narrow, obviously-correct carve-out or scope clarification still counts
as an edit, because it changes what the record says was decided back then.

Reversing, narrowing, or carving an exception into an existing decision:

1. Create a **new** ADR for the new/narrower decision. If it genuinely
   replaces the old one, give it `supersedes: [old-slug]`. If it only carves
   out a specific exception and leaves the original decision otherwise
   intact, it doesn't supersede anything — write it standalone and reference
   the old ADR by `[[old-slug]]` in its Context.
2. Only when it truly supersedes: edit the old ADR's frontmatter alone
   (`status: superseded`, `superseded-by: new-slug`). Its body never changes,
   superseded or not.

The tempting shortcut — adding a "Scope" or "Exception" section straight into
the accepted file — looks like a small, harmless diff. It isn't: it destroys
the "what did we actually decide, and why, at the time" record the whole
convention exists to preserve. Treat it as a high-severity finding regardless
of how correct the inserted text is.

## Frontmatter and filename

```yaml
---
status: accepted        # proposed | accepted | superseded | deprecated
date: 2026-09-10         # creation date, matches the filename, never edited
area: [backend]          # one or more of: backend, apple, web, cross-cutting
supersedes: []           # slugs of ADRs this one replaces
superseded-by: null      # slug of the ADR that replaced this one, if any
---
```

Filename `YYYY-MM-DD-kebab-case-slug.md`, never renamed or moved once
created — other documents and agents reference it by slug, permanently. No
sequential numbers (they'd force renumbering or collide when two PRs add an
ADR concurrently) and no central index (a hand-maintained list is its own
staleness hotspot) — discovery is a flat `ls docs/adr/` plus grepping `area`.

## Before committing, check

- [ ] If this PR introduces a new architectural pattern, it added an ADR for
      it in this same PR — not a promised follow-up.
- [ ] No diff touches the Context/Decision/Consequences of an ADR whose
      `status` was already `accepted` before this PR started.
- [ ] A reversal, narrowing, or carve-out is a new file with `supersedes` or a
      cross-reference — never a section inserted into the old one.
- [ ] Filename and `date` match; `area` lists every platform the decision
      actually governs.
