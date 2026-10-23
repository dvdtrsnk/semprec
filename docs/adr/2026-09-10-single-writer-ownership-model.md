---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Every piece of state has exactly one owning process

## Context

Modules and services in the backend (`packages/*`, `modules/*`, `services/*`)
often need to react to the same data — e.g. an email-sync process and an
inbox-processing pipeline both touching an `inbox` item. Without a rule,
it's tempting for a second process to "just also update" a field it needs
correct, in addition to the process that already sets it.

## Decision

Every field of persisted state has exactly one owning process, named by the
module contract's `owner_process` model:

- `owner: 'user'` fields are written only via user-initiated choke-point
  calls.
- `owner: 'system'` fields are written only by the single process the
  module contract names.

A second process writing the same field is a bug even when the value it
writes is correct — because two writers drift over time, and the
`owner_process` check exists precisely to catch that. If a feature seems to
need a second writer, the fix is an explicit ownership handoff recorded in
the module contract, not a quiet extra write.

## Consequences

- Ownership violations are a high-severity review finding
  (`review-rules/rules.md`, `review-rules/tasks/architecture.md`) regardless
  of whether the written value is correct — the violation is structural, not
  behavioral.
- A feature that needs cross-module coordination must design an explicit
  handoff (documented in the module contract) rather than reach across an
  ownership boundary, which is more upfront design work but keeps write
  responsibility traceable to one place per field.
