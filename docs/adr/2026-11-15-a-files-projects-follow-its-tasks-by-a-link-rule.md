---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# A file's projects follow its tasks by a link rule

## Context

A file attached to a task shows a project next to the task (issue #1702). By
default the file should take the task's project and follow it, until a user or
Semp changes the file's project by hand. The attach creates the
`Files.tasks` edge (the inverse of `Tasks.files`), and a task's single project
is `Tasks.project`, the inverse side of `Projects.tasks`.

`Files.projects` is `owner: user`. [[2026-09-10-single-writer-ownership-model]]
requires an explicit ownership handoff before a second process writes a
field. [[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]]
made that handoff for three Transcripts relations and
[[2026-11-11-action-item-tasks-inherit-project-and-people-by-link-rules]] for
two Tasks relations. Both name their own rules and relations, so neither
covers `Files.projects`. [[2026-11-14-an-attachment-inherits-the-project-of-its-thread-by-a-link-rule]] did make
that handoff for `Files.projects`, for the rule `fileProjectFromThread` (`Threads.project` to `Files.projects`, via
`Threads.attachments`), and this ADR adds the second rule over the same property.

The alternatives were code that copies the project when a file is attached and
when the task's project changes, which would be a second propagation mechanism
next to the link engine and would need its own rules for a user's change, and
a copy made by the client, which leaves no value link and follows nothing.

## Decision

The `systemDatabases` manifest declares one more link rule,
`fileProjectsFromTasks`: `Tasks.project` to `Files.projects`, via
`Files.tasks`. No route is added and the link engine is not changed. The rule
runs in the transaction that writes the via edge, from whichever side it is
written, and the `valueLinksPropagate` job carries a later change of the
task's project to the files that follow it.

Ownership handoff: `Files.projects` stays `owner: user`. The `valueLinks`
process writes it, as a system writer, only while the file's value link for
`projects` is `on`; the choke point refuses the write otherwise. A user or
agent write that changes the file's projects ends the link.

A file attached to two tasks holds the union of their projects, once each when
they are the same. The engine makes a many-valued target the union of the
values of all the sources of its link, and attaching to a second task adds
that task as a source of the file's link. A change of one task's project
replaces only that task's contribution. Removing the `Files.tasks` edge of one
task leaves the file following the other tasks. No order of the sources is
kept, so no task is "the first". An option that keeps only one task needs a
new field in the rule declaration, an order of the sources and a rule for
what happens when that task is detached; it is not built.

A file that already has a project of its own when it is attached to a task
keeps it and gets no link. The engine creates a link only into an empty
property that has no link, so the task's project is not forced onto the file
and a later change of the task's project does not reach it. A link never
starts broken, because `value_links.broken_by` is `user` or `agent` only, so
`links.projects` has no entry for such a file and `link.relink` on it answers
`409` as on any property without a link.

`Files.projects` is the target of two rules, `fileProjectFromThread` and this one, and a file holds one value link per
property. The rule that links the file first keeps the link: `linkRuleEdgeHook` skips a link of another rule, so the
other rule neither creates a link nor adds a source to it. A file that a mail message brought has the `on` link of the
thread rule from ingest, also while the thread has no project, so attaching it to a task gives it no project and a
later change of the task's project never reaches it; the file follows its thread. The other way round, a file attached
to a task first keeps the task's link, and a thread that attaches it later contributes nothing. No order between the two
rules is added and the engine is not changed. `attachmentProjectInheritance.test.ts` records both results.

`Files.projects` is also the target of this rule and the via relation of
`fileCompaniesFromProjects` (`Projects.company` to `Files.companies`). A
task's project therefore reaches the file's company in a second hop: the
engine's write of the `Files.projects` edge is a via edge of the company rule.
The rule graph stays acyclic: the other direction, a rule from `Files.projects`
into `Tasks.project`, would close a cycle with this rule and fails the
manifest validation.

This ADR adds no order of its own for a user or agent edge write on
`Files.projects`. Such a write, which ends the file's link, runs in the order
that
[[2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links]]
decided for every link rule's via relation.

## Consequences

- Nothing is backfilled. A file attached to a task before the rule existed got
  no link from that write and takes nothing; the engine has no replay of
  existing edges.
- A file keeps the project it had when its last source task is detached: the
  link is deleted with its last source and the project stays as the file's own
  value, so a relink answers `409`.
- A task with no project gives the file no project, and the link is `on`. The
  file gets the project when the task gets one.
- A recurring task carries its `Files.tasks` edges to the next instance, and
  the advance moves the link's source from the finished instance to the next
  one (issue #1673). The file follows the current instance only; the finished
  instance stays attached to the file by its edge but contributes no source,
  so a later change of its project does not reach the file.
- A change of the task's project reaches the file through the
  `valueLinksPropagate` job, so the file holds the previous project until that
  job has run. A write of a `Tasks.project` edge now queues one such job for
  this rule, and a test that writes one runs in a tenant scope, because the
  job needs one.
