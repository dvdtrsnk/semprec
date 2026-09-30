---
status: accepted
date: 2026-09-28
area: [backend]
supersedes: []
superseded-by: null
---

# A module's own transactional side effect on a specific write runs inline in the choke point, gated by module identity and the patch's own content

## Context

Issue #24's rolling model keeps exactly one open instance of a recurring
task at any moment: completing it (writing `status: 'done'`) must create the
next instance, carry forward its properties and relation edges, and
deactivate the old recurrence record — atomically with the `done` write
itself, or a crash between the two steps leaves either two open instances or
a task that silently stopped recurring.

[[2026-09-19-derived-system-properties-computed-inline-at-choke-point]]
covers a related but distinct shape: a property computed from other
properties on the *same* item (Tasks' `time` from `timeFrom`/`timeTo`),
written inline in place of the value the caller would otherwise have had to
supply. It explicitly scopes itself to that shape — its Decision section
describes value derivation merged into the row before insert or before the
patch is applied, and its Consequences section frames the pattern as "an
unconditional, ownership-keyed derived property."

The task-recurrence advance is a different shape: it does not compute a
value for the property being written, it reacts to that property's write by
creating a new item in the same database, writing a row in a separate table
(`task_recurrence`), and re-linking relation edges — and it runs only when
the patch's value matches a specific condition (`status === 'done'`), not on
every write to the owning module's database. Its failure mode differs too:
a derived property is deterministic and idempotent to recompute, while a
side effect that creates a new item is not something a caller can safely
retry blind of what the first attempt already committed.

The alternative — requiring every caller that marks a Task `done` to
separately call an explicit "advance recurrence" step — was rejected because
it reintroduces the same drift problem the `time` derivation ADR already
argues against: every present and future write path (the web client's
Tasks UI, an agent proposal's confirm step, a CSV import, a background job)
would have to know the obligation exists and remember to discharge it in
the same transaction as the `done` write. Missing it in just one path
silently breaks the rolling-model invariant for that path.

## Decision

`updateItemWithClient` (`chokePoint/itemWrites.ts`) calls
`advanceTaskRecurrenceWithClient` inline, in the same transaction as the
properties-patch write, gated by two conditions together: module identity
(`database.ownerModuleId === TASKS_MODULE_ID`) and the patch's own content
(`input.propertiesPatch.status === 'done'`). This is the general shape for a
module's own transactional side effect on a specific write:

- Runs inside the choke point's existing transaction, not a separate one the
  caller has to remember to wrap around both steps — atomicity is the choke
  point's responsibility, not every caller's.
- Gated by module identity *and* the triggering write's own content, not
  module identity alone — the side effect fires only for the specific patch
  shape it exists to react to, unlike a derived property which recomputes on
  every write touching its inputs regardless of value.
- Implemented in the module's own file
  (`tasks/advanceTaskRecurrenceWithClient.ts`), not inline in
  `itemWrites.ts` itself, and passed `createItemWithClient` as a parameter
  rather than importing it — `itemWrites.ts` calling into the module and the
  module calling back into `itemWrites.ts`'s own exports would form an
  import cycle the `no-choke-point-rollup-cycle` dependency rule forbids.
- Idempotent by construction against a repeated trigger: the side effect
  deactivates the state it reacts to (`setTaskRecurrenceActive(..., false)`)
  as part of the same transaction, so a second `done` write against the same
  item — the choke point's own re-entry, or a genuinely repeated caller
  request — reads that state and no-ops rather than creating a second next
  instance.

## Consequences

- A crash between the `done` write and the recurrence advance is
  impossible by construction: they are one transaction, not two steps a
  caller could partially commit.
- A future module needing the same shape — react to a specific write with a
  transactional side effect elsewhere in the schema — follows this pattern:
  gate on module identity and the patch's own content, implement in the
  module's own file, take the choke-point's write functions as parameters
  rather than importing them back.
- This is not the derived-property pattern: a reader looking for "why does a
  write to this module trigger something beyond the property patch itself"
  should look here, not treat
  `2026-09-19-derived-system-properties-computed-inline-at-choke-point` as
  covering it — that ADR's scope stays limited to same-item value
  derivation.
- `updateItemWithClient` keeps accumulating one module-specific branch per
  reactive behavior (the `time` derivation, this recurrence advance, the
  Emails desired-flags write below it). The same revisit-if-a-third-shows-up
  reasoning as the `time` ADR's Consequences applies per shape, not in
  aggregate — a per-module hook table becomes worth it if either shape grows
  a second instance, not merely because the file has multiple branches.
