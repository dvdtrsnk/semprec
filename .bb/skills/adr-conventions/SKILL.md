---
name: adr-conventions
description: "When a decision needs an Architecture Decision Record, and the append-only rules for writing, superseding or narrowing one. Load this BEFORE introducing a pattern that no existing ADR and no review-rules/ line covers - deciding it silently is the exact failure this convention exists to prevent, and it is one of this repository's most repeated review findings. Triggers on: docs/adr/, any file you are about to add or edit there, a new cross-cutting mechanism, a new package, a traversal or protocol or lifecycle contract documented only in code comments, a Rule: or only-X-may comment, a lock or transaction-granularity choice, a write deliberately outside an operation's transaction, an ownership handoff or write access to another owner's data, a security stance future features must respect, delivering what an ADR deferred, and any wish to reverse or carve an exception into an accepted decision. Skip only when an existing ADR or rule already covers the pattern."
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

A missing ADR is this repository's second most common review finding. It is
almost always a pattern decided in a code comment or docstring. You are
introducing such a pattern when any of these is true:

- you write *Rule:*, *only X may Y*, *must always* or *the only way* into a
  comment;
- you set a lifecycle, shutdown, retry or ordering contract that later jobs or
  routes will follow;
- you choose a transaction granularity, a lock, or a deliberate write outside
  an operation's transaction;
- you hand ownership of a table or field to another process, or give one
  process write access to another owner's data;
- you adopt a security stance that future features must respect (an SSRF
  policy, a credential format);
- you make an exception to an accepted ADR, or deliver what an ADR explicitly
  deferred.

Before you cite an existing ADR as covering the pattern, read it. Citing one
that does not cover this case is the same finding as citing none.

## What the ADR says must be true

Agents follow ADRs literally, so an inaccurate one is worse than none:

- Check every lock, isolation or atomicity claim against what the code does:
  the isolation level the transaction runs at, the row locks it takes, and the
  locks a DDL statement takes (including the locks a foreign key takes on the
  table it references). "Same transaction" is not "serialized" (see
  `state-writes` §4, the bullet *Being inside the transaction is not enough*).
- Every rule states why it exists, and every format states its exact encoding.
- The title and the opening sentence are no looser than the policy in the body.
  Sections do not contradict each other.
- Do not reuse a word that already names something else in this codebase.
- When the decision extends a mechanism another ADR introduced, reference that
  ADR by `[[slug]]` and say what the extension adds. Name the new
  consequences in this ADR; the old one's body stays as it is (below).

When your change alters behaviour that an ADR, a skill or `.bb/AGENTS.md`
describes, grep `docs/adr/` and `.bb/skills/` for it. A changed decision gets a
new ADR (below). A skill you change gets its body, its checklist (where it has
one) and its `description` triggers updated together, because the
description is what decides whether the skill loads at all.

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
area: [backend]          # one or more of: backend, web, mobile, cross-cutting (apple: only ADRs dated before 2026-10-24)
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
- [ ] No comment in the diff states a *Rule:* or an *only X may* that no ADR
      or review rule records.
- [ ] Every lock, isolation and atomicity claim in the ADR matches the code.
- [ ] Every ADR whose mechanism this one extends is cross-referenced.
- [ ] Every skill this change makes stale was updated, triggers included.
