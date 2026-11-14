---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# Inbox editor schema rules are evaluated on the card's effective values

## Context

[[2026-10-25-server-driven-inbox-editor-schema]] declares `required` and `when` on the fields of a
card editor and defers their evaluation to #1928: a missing required field is an error on confirm
and a warning on edit, and a field hidden by its condition is neither validated nor written. It does
not say which values a condition reads, where a field that is no property of the destination keeps
its value, or which cards the rules apply to. [[2026-11-12-inbox-editor-schema-pseudo-keys-area-and-markdown]]
says the storage of the step fields is not decided by the schema.

## Decision

**Effective values.** The values a rule reads are the card's effective values: for each active step
(a single-step envelope is the one step `primary`), the step's `properties` overlaid with the user's
values for that step's ref in `userOverrides` ([[2026-10-25-multi-step-proposal-envelope]]). The
primary step comes first, and a field is read from the first step that has its key. A value counts
as empty when it is `undefined`, `null`, an empty or whitespace-only string, or an empty array. A
condition on a field that has no value is false for `equals` and true for `notEquals`.

**Pseudo fields.** A schema field that is no property of the card's destination is a pseudo field.
For a database envelope the destination keys are the target database's properties; for a Markdown
`pageContent` envelope they are `markdown`, `placement`, `heading` and the keys the envelope holds.
A pseudo value is accepted by `PATCH /api/proposals/:id/values` for any ref the card has, stored in
`userOverrides` under that ref, counted in `userEditedKeys` like any value, kept out of the
effective envelope, and never written to the created item. A `pageContent` envelope answers the
pseudo fields `page` and `day` with its target, because nothing else holds them.

**Where the rules apply.** To a card whose destination a module maps to a card kind and whose
envelope creates what the schema describes. They do not apply to a `relation` envelope, to a
multi-step envelope whose primary step is an `update` or `link`, to a `pageContent` envelope of the
legacy block shape (no `markdown`), or to a destination that is a `clarify` card (a database no
module maps to a card kind, whose card list shows the page editor only as a fallback).

**Confirm and edit.** Confirm raises a `ValidationError` for the first visible required field
without a value, after the envelope validation and before any write, with `details.field` and, for
a card of several steps, `details.ref`. The values edit never fails for a missing required field:
it returns every one as `{ ref?, field, code: "required" }`. A schema field does not name a step,
so a missing field of a multi-step card is reported on its primary step. An edit does not count a
hidden field's override in `userEditedKeys`; the override itself stays in `userOverrides` so it is
back when the condition holds again.

## Consequences

- A Files card needs a `file`, a task card a `name`, a journal or page card Markdown: a card
  that lacks one cannot be confirmed, whatever created it.
- A later step field (`followDate`, the fields of a step an editor switches on) is a value in
  `userOverrides` until the multi-step work gives it a home in a step's properties; the rules read
  both places.
- A new module that declares an editor schema is enforced by the same code, with no change here.
- Clearing a hidden field's value when confirm writes is not part of this decision (#1934).

## Alternatives considered

- **Evaluate only on the client.** Rejected by [[2026-10-25-server-driven-inbox-editor-schema]].
- **Store pseudo values beside `userOverrides` in a column of their own.** Rejected: a second
  place for values a user typed, which a revise, a reset and the edited-key count would each have
  to know about.
- **Apply the schema of the card list's `baseKind` to every card.** Rejected: a database no module
  maps to a card kind is shown the page editor only as a display fallback, and requiring a page's
  fields of a card that writes an MCP server would make it unconfirmable.
