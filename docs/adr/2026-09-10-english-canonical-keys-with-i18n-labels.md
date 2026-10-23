---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Canonical stored keys are English; display labels are localized separately

## Context

Semprec's spec and mock grew up in Czech, so Czech names keep appearing in
issues and mock references, and the temptation to keep a Czech key when
transcribing them is real. But the stored world (schema, seed data, API
contracts, i18n files) needs one key space that outlives UI language
choices.

## Decision

Canonical stored keys (`databases.key`, property keys, select-option
values, settings keys) are English camelCase; view-type keys are English
kebab-case. Display labels are never stored as the key or hardcoded in code
or API responses — they live in `cs.json`/`en.json`, keyed by the English
canonical key, and are resolved by `users.locale` before anything
user-facing is sent. Label resolution falls back: explicit per-item `name`
override → `users.locale` file → `en` (the reference locale) → the raw
English key. There's one deliberate exception: `ico` (the Czech IČO
company-registration id), a domain term with no honest English name.

## Consequences

- A key baked into rows, filters, and API contracts can never be
  translated without a data migration; a label lookup is free. This is the
  entire reason the split exists.
- The i18n files are keyed by the English canonical key, so a Czech key
  introduced anywhere simply has no label entry — the design doesn't
  degrade gracefully for mixed-language keys, it breaks outright.
- A Czech key introduced in code or a migration is a high-severity review
  finding; a hardcoded user-facing label is medium
  (`review-rules/rules.md`).
- Anyone transcribing from the Czech spec/mock pays a small translation
  tax up front (pick or reuse an English camelCase key, add both locale
  entries in the same PR) in exchange for the UI language never being
  load-bearing in stored data.
