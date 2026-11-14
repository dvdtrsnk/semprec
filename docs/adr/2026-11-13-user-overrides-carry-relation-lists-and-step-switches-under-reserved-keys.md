---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# User overrides carry relation lists and step switches under reserved keys

## Context

`userOverrides` of a Processing proposal card holds what the user changed, as step `ref` -> key ->
value, next to the assistant's own output in `aiProposal`
([[2026-10-25-multi-step-proposal-envelope]]). Until now a key was a property key or a pseudo field
key ([[2026-11-13-inbox-editor-schema-rules-read-the-cards-effective-values]]). A card also lets
the user replace the targets of a relation and switch a secondary step on or off, and those edits
need a home that a revise, a reset and the edited-key count can all read.

## Decision

A ref's overrides may hold two reserved keys beside the field values:

- `relations`: relation property key -> the full list of target item ids that replaces the
  assistant's list for that key. A key that is not listed keeps the assistant's list.
- `enabled`: a boolean, whether the step is carried out.

`PATCH /api/proposals/:id/values` takes them as the request parts `relations` and `steps`, and
refuses the names `relations` and `enabled` as keys of `set`, so no property key can collide with
them. A database that has a property of one of those names cannot have it edited through `set`.

An override exists only while it differs from the assistant's envelope: a list holding the same item
ids in any order, or a switch equal to the step's own `enabled` (true when absent), is dropped. A
list also differs from one that holds a reference to another step. `userEditedKeys` names them
`ref.relations.<propertyKey>` and `ref.enabled`. A step that is switched off, by the user or by the
assistant, has its field values and relation lists left out of `userEditedKeys`, as the editor
schema's hidden fields are; the overrides stay stored for when the step is switched on again. A
relation key that the editor schema hides is left out as well.

The effective envelope in `proposal` carries the result: a single-step envelope's `relations`, a
step's `relations` (an `update` step's `after.relations` too, and its own `relations` for a key it
already holds, because validation requires the two to agree) and a step's `enabled`. It is validated
as confirm validates it, so a missing target and a relation the target database does not have are
the errors confirm raises. A request that switches the primary step off is refused before anything
is written.

## Consequences

- A revise that keeps manual values keeps only keys that are properties of the new destination
  (`retainOverridesForEnvelope`), so it drops relation lists and step switches and reports them as
  dropped; keeping them across a revise is a decision for the issue that changes revise.
- A row that the values route of #1892 stored before this change under `relations` or `enabled`, as
  an ordinary field value of a database that has a property of that name, is not migrated. A stored
  boolean `enabled` is read as the step switch and a stored value of another shape fails
  `parseUserOverrides`. Moving such a row needs a spelling for a property value of a reserved name,
  which this change does not introduce; it is recorded as a follow-up, and only a database with a
  property named `relations` or `enabled` can have such a row.
- The reset of all manual values (#1912) clears these keys together with the field values, because
  it clears everything stored in `userOverrides`.

## Alternatives considered

- **Separate columns for lists and switches.** Rejected: a second place that the edited-key count,
  a revise and a reset must each read.
- **A different spelling for a switch, such as a `{ ref }` entry in a list.** Rejected: the
  multi-step envelope already has `enabled` on a step, and the override mirrors it.
