---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# A task from an Event's action item inherits the Event's project and people by link rules

## Context

An action item in an Event's detail becomes a task (issue #1724). The task
should take over the Event's project and its participants, without the
tenant's own person, and follow them until a user or Semp changes them. The
task and the Event are connected by one many-to-many relation,
`Events.actionItems` with the inverse `Tasks.sourceEvents`. The task is
created by the generic item create with initial relations
([[2026-11-04-atomic-item-relations-compose-existing-write-owners]]).

`Tasks.project` and `Tasks.people` are `owner: user`.
[[2026-09-10-single-writer-ownership-model]] requires an explicit ownership
handoff before a second process writes a field.
[[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]
made that handoff for three Transcripts relations and added the value filter
that leaves out the own person. It names those rules and those relations, so
it does not cover Tasks.

The alternatives were a custom route that creates the task and copies the
values, which would be a second mechanism next to the link rules and would
need its own code to follow the Event afterwards, and a copy made by the
client, which leaves no value link and follows nothing.

## Decision

The `systemDatabases` manifest declares two more link rules:

- `taskProjectFromEvent`: `Events.project` to `Tasks.project`, via
  `Tasks.sourceEvents`;
- `taskPeopleFromEvent`: `Events.people` to `Tasks.people`, via
  `Tasks.sourceEvents`, with the value filter that leaves out the own person
  (System settings `selfPerson`).

No route is added and the link engine is not changed. The rules run in the
transaction that writes the via edge, from whichever side it is written: the
item create that names `sourceEvents`, the relation endpoint on
`Tasks.sourceEvents` or on `Events.actionItems`, and the confirm of an Inbox
card whose task names a source Event. Validating such a card writes no edge
and so no value.

Ownership handoff: `Tasks.project` and `Tasks.people` stay `owner: user`. The
`valueLinks` process writes them, as a system writer, only while the value
link of that item and property is `on`; the choke point refuses the write
otherwise. A user or agent write that changes the value ends the link.
`Tasks.project` is the inverse side of `Projects.tasks`, so a user can also
change it from the project, and that write ends the link as well.

No rule copies a company, and Tasks has no company relation. The derived read
(`derived/derivedValueReads.ts`) gives a task its area through its project; it
derives a company only for an Event, so a task read with its links carries no
company.

The removal of the source edge detaches the Event from the task's links of
any state. The engine removes an Event from a link only while that link is
`on` and its task is not in the Trash. A link the user or Semp had ended would
keep the Event as its source: the value would read as inherited from an Event
the task has no edge to, and a relink would make the task follow that Event
again. An edge-changed hook for the removal of a `Tasks.sourceEvents` edge
(`tasks/taskSourceEventLinkDetach.ts`), registered after the engine's hook
through [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]],
removes that Event from the sources of the task's `project` and `people`
links, whatever their state, and deletes a link that is left without a
source, in the transaction of that removal. The values are not touched.
[[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]
decided the same for a transcript and its Event. The trash of an Event needs
no such step, because the source detach of issue #1656 removes a trashed item
from links of any state.

## Consequences

- A rule fills only an empty property, and the item create writes its
  relations in the order the request lists them. A project or people listed
  before `sourceEvents` are the task's own values and get no link. A project
  listed after `sourceEvents` meets the link that edge has just created. When
  the Event has a project, the listed one is a second value of
  `Tasks.project`, which holds one: the request is refused with
  `409 cardinality_violation` and nothing of it is written. When the Event has
  no project, the link is `on` with no value: the listed project is written
  and, in a request of a user or of Semp, ends that link as their change, so
  the task is created with that project and a `broken` project link that
  names the Event.
- A request repeated with the same `Idempotency-Key` returns the committed
  task and writes no edge, so nothing is inherited again.
- `Tasks.sourceEvents` holds many Events. The task's people are the union of
  the participants of all its source Events. While those Events name more
  than one project, the engine leaves the task's project as it is.
- When the source edge is removed, from the task or from the Event and by
  whichever writer, no link of that task names that Event any more. A link
  that is left without a source is deleted, whether it was `on` or ended by
  the user or Semp: the value stays as the task's own, and a relink of that
  property answers `409`.
- A link that another source Event still feeds keeps that Event and its
  state. The engine recomputes it when it is `on`; a link the user or Semp
  had ended stays ended and keeps its value, and a relink takes the values of
  the Events it still names.
- A task that is disconnected from its Event and linked to another one takes
  the new Event's values into every property that is empty, also into a
  property whose link the user or Semp had ended before the disconnect,
  because that link is gone.
- The hook locks the task's `project` and `people` link rows, in that order,
  and takes no lock of its own on the task row. The engine's hook, which runs
  before it in the same transaction, has locked the task row and, for a task
  that is not in the Trash, the link rows of the rules that resolve,
  `project` before `people`.
- A task whose links the hook changed is announced after the commit, so
  clients read its links again. The engine announces nothing when it deletes
  a link that was `on`.
- For a task in the Trash the engine leaves the links as they are. The hook
  detaches the Event from them as well and announces nothing; a link that
  keeps another source keeps the values it had.
- A later change of the Event's project or participants reaches the task
  through the `valueLinksPropagate` job, so the task holds the previous value
  until that job has run.
- A write of an Events `project` or `people` edge queues one
  `valueLinksPropagate` job for each rule that reads that property: the
  transcript rule and the task rule.
- Nothing is backfilled. A task whose `sourceEvents` edge was written before
  the rules existed got no value link from that write and takes over nothing.
- In a tenant whose Tasks database has no `sourceEvents` relation yet, both
  rules are unresolved and copy nothing.
