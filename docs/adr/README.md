# Architecture Decision Records

This directory records why Semprec's architecture is shaped the way it is —
not what the code does (the code says that), but the context, the decision,
and the trade-off accepted at the time. Both humans and AI agents (planning
a new feature, reviewing a PR, or implementing an issue) should check here
before introducing a pattern that might already have been decided — for or
against — elsewhere.

## Conventions

- **Filename**: `YYYY-MM-DD-kebab-case-slug.md`. The date is when the ADR
  was created; the slug is a short, permanent identifier. Once created, a
  file is **never renamed or moved**, even when its status changes — other
  documents and agents reference it by slug, and that reference must stay
  valid forever.
- **No sequential numbers.** Numbering would force renumbering or produce
  merge collisions when two PRs add an ADR concurrently, which is common in
  this repo's parallel-agent workflow. Date + slug never collides in a way
  that requires editing an existing file.
- **No central index.** A hand- or CI-maintained list of all ADRs would
  itself become a merge-conflict and staleness hotspot. Discovery is a flat
  directory listing (`ls docs/adr/`) plus grepping the frontmatter fields
  below — cheap for both humans and agents, and it can never go stale.
- **Topic is a tag, not a folder.** Classification lives in the `area`
  frontmatter field, not in a subdirectory, because a decision's
  classification can change (or span multiple platforms) without forcing a
  file move.

## Frontmatter

```yaml
---
status: accepted        # proposed | accepted | superseded | deprecated
date: 2026-09-10         # creation date, matches the filename, never edited
area: [backend]          # one or more of: backend, apple, web, cross-cutting
supersedes: []           # slugs of ADRs this one replaces
superseded-by: null      # slug of the ADR that replaced this one, if any
---
```

## Superseding a decision

Reversing or replacing a decision never edits the old file's body. Instead:

1. Create a new ADR describing the new decision, with `supersedes: [old-slug]`.
2. Edit only the old ADR's frontmatter: `status: superseded`,
   `superseded-by: new-slug`. Its body stays as a historical record of what
   was decided and why, at the time.

## When to write one

Write an ADR for a decision that shapes how future code gets written and
that a reasonable alternative existed for (a choke-point vs. direct writes,
one AI-provider gateway vs. per-caller SDK usage, expand/contract migrations
vs. in-place changes). Don't write one for a plain hygiene rule with no real
alternative (never log secrets, sanitize HTML) — those stay in
`review-rules/rules.md` as rules, not decisions.

A PR that introduces a genuinely new architectural pattern (not covered by
an existing ADR or `review-rules/`) should add an ADR for it, `status:
proposed` or `accepted` as appropriate.
