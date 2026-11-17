---
name: adr-conventions
description: "Where architectural rules live and how they change - the current documents under docs/architecture/ are updated in place in the same PR; a separate ADR under docs/adr/ is only for a mobile/web decision or a genuinely new cross-cutting one, never for a local pattern. Load this BEFORE changing a rule that docs/architecture/ states, or adding or superseding a file under docs/adr/. Triggers on: docs/architecture/, docs/adr/, a new package or cross-cutting mechanism, a write outside the choke point or another owner's data, a new lock or transaction-granularity rule that other features must follow, a security stance future features must respect, and any wish to make an exception to a documented rule. Skip for a pattern local to one module or operation."
---

# Architectural rules: update the document, do not add a record

Backend and cross-cutting rules are in `docs/architecture/` (index:
`docs/architecture/README.md`). They describe the code as it is today. Mobile
and web decisions remain ADRs under `docs/adr/` (format: `docs/adr/README.md`).

## Is this an architectural change?

Yes when the change sets something other features must follow or breaks a rule
a document states:

- a write outside the choke point, a second writer for an owned table or field,
  an ownership handoff;
- a side effect that does not follow the commit, a transaction opened outside
  `withTransaction`, a lock order other code must respect;
- a tenant-isolation, credential or outbound-network stance;
- a new package, process, queue lane or cross-module registry.

No when it is local: one module's lock order, one operation's bounded limit, a
helper, a retry in one adapter. Local patterns live in the code, with a short
comment only when the reason is not obvious. They get no document and no ADR.

## How to change a rule

1. Edit the relevant `docs/architecture/` section in place, in the same pull
   request as the code. State the new rule as current fact: no history, no
   "now", no issue numbers, no dates.
2. Keep the document concise; delete a rule the code no longer follows rather
   than annotating it.
3. Every claim must be true of the code: the isolation level, the row locks
   taken, what "same transaction" actually guarantees (see `state-writes`).
4. Only a genuinely new cross-cutting decision that fits no existing document
   gets a new file — prefer a new section in the closest document.

Code comments never cite `docs/architecture/` or an ADR for ordinary code; the
document is found by topic, not by back-references.

## Mobile and web ADRs

- Discover them with `node .github/scripts/adr.mjs --platform <platform>`
  (`mobile`, `shared`, `android`, `apple`, `ios`, `macos`, `web`); mobile
  selections include the historical `apple` tag.
- Filename `YYYY-MM-DD-kebab-case-slug.md`, never renamed or moved; frontmatter
  `status`, `date` (matches the filename), `area`, `supersedes`,
  `superseded-by`. New Apple decisions use `area: [mobile]`.
- An accepted ADR's body is not edited. A reversal is a new ADR with
  `supersedes: [old-slug]`; the old file changes only its frontmatter
  (`status: superseded`, `superseded-by`).

## Before committing, check

- [ ] Code that changes a documented rule updates its `docs/architecture/`
      section in this pull request.
- [ ] No new ADR for a backend rule or a local pattern.
- [ ] Every lock, isolation and atomicity claim in the document matches the code.
- [ ] A skill this change makes stale was updated, `description` triggers included.
