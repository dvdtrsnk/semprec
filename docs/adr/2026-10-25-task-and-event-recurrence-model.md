---
status: accepted
date: 2026-10-25
area: [backend]
supersedes: []
superseded-by: null
---

# A recurring series is one rule and one template; only occurrences with state are stored items

## Context

Recurring tasks work today as a rolling chain. `task_recurrence` (created in
`0004_ten_databases.sql`) holds one row per task with `item_id`, `mode`
(`fixed` or `floating`), `rule` (jsonb) and `active`. When a task is set to
`done`, `taskRecurrenceItemUpdateHook` runs `advanceTaskRecurrenceWithClient`
in the same transaction: it creates the next task instance, inserts a new
`task_recurrence` row for it and deactivates the old row. Instances know
nothing about a series or about the day of the occurrence they stand for, so
there is no series history, no way to complete a future day in advance and no
way to mark a day as missed.

Events will get recurrence as well, and the calendar timeline must expand
occurrences of both Tasks and Events the same way. One decision on how an
occurrence is represented has to exist before either is built.

## Decision

**Model.** A recurring series is described by one rule and one template. An
occurrence that has a state of its own (done, wontDo, missed, moved, or
otherwise edited) is a real item of the owning database (Tasks or Events).
Future occurrences that have no state of their own are only projected, never
stored. Completing a task occurrence creates the next one, as today.

**Shared identifiers (Tasks and Events).**

- `seriesId`: a uuid, one per series, stable for the whole life of the series.
- `occurrenceDate`: the calendar day the rule assigns to the occurrence.
  Moving an occurrence changes its start or due value, never its
  `occurrenceDate`.

**Series storage for Tasks.** The rule and template live in one
`task_recurrence` row per series: one `series_id`, one `anchor_date`, one
`template`. Its `item_id` always points at the current open instance and is
overwritten when the series advances, so no new row is created per instance
(this replaces the insert-new, deactivate-old behaviour above).

**Ownership.** `seriesId`, `occurrenceDate` and a `recurrence` projection are
Tasks properties with `owner: 'system'`: clients cannot write them, and only
the Tasks module writes them, inline in the choke-point as described in
[[2026-09-28-module-transactional-side-effects-inline-at-choke-point]].

**Addressing.** A materialized occurrence is a normal item with a normal item
id. An occurrence that is not materialized is virtual and addressed as
`<seriesId>@<occurrenceDate>`, with `occurrenceDate` as `YYYY-MM-DD`.

**Lock order.** Any code that touches both takes locks on items first, then on
`task_recurrence`. Taking them in the opposite order can deadlock against the
item-update hook, which already holds the item row when it reaches
`task_recurrence`.

**Events.** Events reuse `seriesId`, `occurrenceDate` and the virtual
addressing form. Where their rule and template are stored is decided in the
Events recurrence issue (#1817), against this ADR.

**Series edits and deletion.** Editing a series updates the template and its
open occurrences; it never rewrites done, wontDo or missed occurrences, which
keep the values they were completed with. Already materialized future
occurrences that are still open follow the new template unless they were edited
themselves. Deleting a series removes its `task_recurrence` row and its open
occurrences; done, wontDo and missed occurrences stay as ordinary items and
keep their `seriesId` as history.

## Alternatives considered

Store the rule as an owner-user property `recurrence` of the Tasks database,
keep every occurrence virtual, materialize only exceptions, and drop
`task_recurrence`. Rejected: generic queries, counts and search operate on
stored items only, so a virtual-only model loses them for open occurrences, and
every consumer would need a second code path to see what is due.

## Consequences

- Later work builds on these names: series identity and backfill (#1605),
  the missed status (#1668), the Tasks schema (#1540), carrying fields to the
  next instance (#1673) and Events recurrence (#1817).
- Open occurrences are searchable and countable like any item; far-future
  occurrences cost nothing to store.
- The timeline needs a projection step that merges stored occurrences with
  virtual ones and must skip a virtual day that already has a stored item.
- This ADR records the target shape. Until the migration and code in those
  issues land, the rolling chain described in Context is still what runs.
