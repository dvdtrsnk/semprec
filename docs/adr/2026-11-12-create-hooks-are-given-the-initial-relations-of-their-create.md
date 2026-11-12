---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# Create hooks are given the initial relations of their create, which are written after them

## Context

[[2026-10-09-item-create-domain-hooks]] runs a domain's create hooks inside the insert's transaction,
after a real insert and not on an idempotency-key replay. Issue #1590 let `item.create` take
`relations`: `createItemWithRelationsWithClient` (`backend/packages/data/src/chokePoint/itemCreateWithRelations.ts`)
inserts the item, which runs the create hooks, and then checks and writes each relation on the same
client.

[[2026-11-11-new-events-get-their-calendar-in-a-create-hook]] added a create hook that links a new
Event to the tenant's default calendar. `Events.calendar` is single-valued, so a create whose
`relations` named another calendar met the edge the hook had written and was refused with
`cardinality_violation`. That decision left the answer to issue #1777 and named both candidates:
write the relations before the hooks, or tell the hooks about them.

Writing the relations first would change the order for every database, not for Events alone, because
the choke point knows no domain. An edge write runs the edge hooks of its relation, so those would run
for an item whose create hooks have not run yet. The Inbox shows what that means: its create hook
refuses an item without a valid date and time and links the item to its Journal day, and the
changed-edge hook of the Inbox `type` relation fires the Inbox `update` heartbeats for the item and
queues the recompute of the Journal day the item is linked to. With the edges first, that hook would
run for an item that was not judged yet and has no Journal day edge. The Events rules would likewise
judge an Event only after its edges were written.

## Decision

**The order stays.** A create with initial relations inserts the item, runs the create hooks, and then
checks and writes the relations one after the other in the order given.

**The create hooks are told.** `ItemCreateHookContext.initialRelations` carries the relations that
`createItemWithRelationsWithClient` was given: for each, the relation property id and the target item
ids. A relation whose property key the caller could not resolve is not listed; a create that has one
throws after the hooks. A create given no relations carries an empty list. A create through
`createItemWithClient` leaves the field absent.

**The field is an announcement, not a fact.** When the hooks run, the create has written none of
those edges and has checked none of the relations: the property may belong to another database, a
target may not exist, a single-valued relation may name no target or several.
`createItemWithRelationsWithClient` throws when it cannot write one of them. A hook may therefore use
the field to leave a write to the create. It must not treat it as an edge that exists.

**The default-calendar hook leaves the calendar to the create.** `defaultCalendarCreateHook` writes no
edge when the initial relations name the `calendar` property of the Events database, whatever targets
they name. The create then writes that relation itself, through `createRelationWithClient` with the
checks every relation write runs and as a write of the create's own writer, where the hook writes its
edge as a system write. Because the relation is single-valued, the create stores exactly one calendar
edge or throws. The hook's other answers are unchanged, and it still links the default calendar when
the relations name other properties only.

## Consequences

- `item.create` for an Event with `relations` that name a calendar, a project and people stores the
  Event and those edges through `chokePoint.createItemWithRelations`, which runs the whole create in one
  `withTransaction`: a refused relation, a refused Event or a later failure rolls all of it back.
- A create hook cannot rely on finding the Event's calendar edge, wherever it is registered: when the
  relations name the calendar, the edge is written after every hook. A hook that needs the calendar
  reads the stored edge and, when there is none, the calendar named in `initialRelations`, which is
  not checked at that point.
- The calendar named in `relations` is checked as a relation target: a live item of the calendars
  database, visible to the tenant in scope. The hook's rule for a calendar chosen with
  `withChosenCalendar` (a `kind` that is empty or `own`) and its `FOR SHARE` lock on the calendar row
  do not apply, as they do not apply when a user changes the calendar of an existing Event.
- A calendar chosen with `withChosenCalendar` is ignored and not checked when the relations name the
  calendar.
- A caller that hands `createItemWithRelationsWithClient` a client and swallows its error inside the
  open transaction can commit an Event that has no calendar. No production caller does that.
- The proposal confirm (`backend/packages/data/src/inbox/proposalActions.ts`) creates its item with
  `createItemWithClient` and writes the relations of the envelope itself, so its create hooks are given
  no initial relations. What [[2026-11-11-new-events-get-their-calendar-in-a-create-hook]] says about an
  Event proposal whose relations name `calendar` still holds; this decision does not change that path.
- An idempotency-key replay runs no hook and writes no relation, as before; it returns the stored
  item whatever relations the replay names.
