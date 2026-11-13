---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# An Event's recurrence rule is a user-owned `json` property named `recurrence`

## Context

[[2026-10-25-task-and-event-recurrence-model]] decides that a recurring series is one rule and one template, that an
occurrence with a state of its own is a real item, and that future occurrences without one are only projected. It
gives the series identifiers `seriesId` and `occurrenceDate` to Tasks and Events alike. For Tasks it stores the
rule and the template in a `task_recurrence` row, because a task series is a rolling chain: completing one open
instance creates the next, and the row's `item_id` follows the open instance. It leaves the storage of an Event's
rule to the Events recurrence issue (gh-1817), "against this ADR".

An Event is different. A recurring Event is one stored item, the first occurrence, and the template of the series
is that item itself: its name, times and place. Nothing advances when an occurrence passes, and no item stands for
the open instance. The rule says on which later dates the series occurs, and an occurrence becomes an item only when
it gets a state of its own, which is a later issue (#1843).

The rule vocabulary is the fixed-rule schema of `tasks/taskRecurrenceRule.ts`, so that one rule means the same for a
Task and an Event.

## Decision

The rule is a property of the Events database: key `recurrence`, type `json`, owner `user`, not locked. Its value
is the fixed rule itself, an object with a `kind` of `weekdays`, `monthDates` or `nthWeekday` and that kind's fields,
as `fixedRecurrenceRuleSchema` defines them. An Event without the key does not repeat. The property is declared in
`seedTenDatabases.ts` for a new tenant and added to an existing tenant's Events database by
`calendar/eventsRecurrenceCutoverMigration.ts`, which inserts the same definition with direct SQL, because the Events
schema is locked.

Only a value that passes the schema is stored. The choke point's create and update hooks for the Events database
(`calendar/eventRecurrenceHook.ts`) refuse any other value written to `recurrence` with 400 `validation_failed` on
`recurrence`. As they sit in the choke point, they judge every write path: REST, the agent operations and MCP.

- `null` is refused. A rule is removed by deleting the Event: the series has no end condition in this version, and
  no route or sheet that edits a rule exists yet.
- The yearly rule `yearDates`, which the fixed-rule schema accepts since the Tasks yearly preset (#2010), is refused
  for Events. The issue says a yearly Event rule is not built in this version, and nothing consumes one. The shared
  day matching of `tasks/nextDueDate.ts` already evaluates `yearDates`; only `parseEventRecurrenceRule` and the
  `EventRecurrenceRule` type of `calendar/eventRecurrenceRule.ts` exclude it. A later issue that builds the yearly
  Event rule lifts the refusal in `parseEventRecurrenceRule` and drops the `Exclude` from `EventRecurrenceRule`.
- A floating rule is refused. A calendar series repeats on dates the calendar gives, not at an interval from a
  completion.

The Event's own `date` is the first occurrence and the start of the series. `eventRecurrenceOccursOn(rule,
seriesStartDate, date)` is true when `date` is on or after the start date and the rule matches it, with the day
matching of `tasks/nextDueDate.ts`: a `monthDates` day that a month lacks is skipped for that month, and an
`nthWeekday` rule with `n` -1 is the last such weekday.

`seriesId` and `occurrenceDate` are not added to Events here. They belong to the materialization of an occurrence.

## Alternatives rejected

- A row per series in a new table, like `task_recurrence`. It exists there because an item id has to follow an open
  instance and a series has an anchor and a template that outlive each instance. An Event series has neither. A
  table would add a second write path beside the choke point, a lock order against item rows, a purge dependent and a
  migration, to store a value of a few bytes that the Event row can carry.
- A system-owned `recurrence` projection written by a calendar process, as Tasks have. The user sets the rule, so a
  system owner would need a route to write it, and the issue's rule is that every write path judges it. An
  owner-user property is written by the generic operations and judged by the hooks.
- Storing the rule as text. The generic operations, search and views already carry `json` properties, and the schema
  check needs a structure.

## Consequences

- Every consumer that reads `recurrence` parses it with `parseEventRecurrenceRule` (or trusts a value the hooks
  accepted). A value written before the hooks, or by a path that skips the choke point, is not repaired.
- The hooks judge only a write that names `recurrence`; an Event stays editable whatever it holds.
- The parse drops keys the schema does not know, but the hooks do not rewrite the stored value, so an unknown key in
  an accepted value is stored as sent.
- A user can write the rule through the generic operations. A route that applies a preset to an Event, and an editor
  for it, are later issues; they build on this property.
