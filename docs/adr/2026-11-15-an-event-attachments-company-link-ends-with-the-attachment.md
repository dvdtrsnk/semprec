---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# An Event attachment's company link ends with the attachment

## Context

A file can be attached to an Event through the `Files.events` relation (issue #1588). Before this decision nothing connected such a file to the Event's project: `Events.project` and `Files.projects` were independent, so the attachment of a meeting for a client project was not found under that project and had no company. The link engine can inherit a value along a relation, and the file's company already follows its projects (rule `fileCompaniesFromProjects`, issue #1653).

The product decision recorded in the epic of this work is: removing an attachment only deletes the `Files.events` edge. The file stays in Files, and the project and company it inherited stay on it as its own values. [[2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge]] made the same decision for a transcript, whose company link ends with its Event. A file differs from a transcript in two ways that make the transcript's rule wrong for it. The file keeps its project when the attachment goes, so the rule of #1653 alone would keep the company following that project. And a file may have a project of its own from before it was attached, or be attached to several Events, so ending the company link on every removal would change what #1653 delivers for such a file.

The write path of an edge on `Files.projects` is ordered by [[2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links]]. This decision adds no order of its own to it.

## Decision

### The rule

The `systemDatabases` manifest declares the link rule `fileProjectsFromEvents`: source `Events.project`, target `Files.projects`, joined through the `Files.events` relation. A file attached to an Event takes that Event's project as an inherited value, and its company then follows from that project through `fileCompaniesFromProjects`: two hops, each of them counted by the hop budgets of [[2026-11-05-value-link-propagation-keeps-separate-hop-budgets]]. A change of the Event's project is carried to its attachments, and from them to their companies, by the `valueLinksPropagate` job.

`Files.projects` stays `owner: user`. The `valueLinks` process writes it, as a system writer, only while the file's value link for `projects` is `on`, as [[2026-09-10-single-writer-ownership-model]] and the ownership handoff of the transcript decision allow; a user or agent write on it ends the link and keeps the value. The rule fills only an empty property: a file that already holds a project keeps it and gets no link, and a file whose `projects` link belongs to another rule (the rule of the attachments of a mail thread) gets no link of this rule, because a property has one link. An Event whose project is in the Trash gives the attachment no project; the engine leaves out values that are in the Trash.

The relation composition the rule creates: `Events.project` is the source of this rule and `Files.events` its via relation; `Files.projects` is the target of this rule and the via relation of `fileCompaniesFromProjects`; `Files.companies` is the target of that rule. So an edge write on `Files.projects` by a user or an agent meets the propagation job, the engine's hook for a `Files.events` edge and the release below on the same file row and the same `projects` link row.

### Nothing is backfilled

The engine creates a link only when a via edge is written and has no replay of existing edges. A `Files.events` edge that existed before the rule gives its file no project and no value link, and a later change of the Event's project does not reach that file, until the edge is written again. This is the decision of #1653 for its rule and of the transcript decision for its rules. No migration, no manifest data-migration entry and no cutover is written for this rule.

### The company link ends with the attachment

`eventAttachmentLinkReleaseEdgeChangedHook` in `blobs/eventAttachmentLinkRelease.ts` is a relation-edge-changed hook ([[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]]). It acts only on the removal of a `Files.events` edge, in the transaction of the removal, and works through the value-link store. It locks the file row first (a file in the Trash included), then the file's `projects` link row, then its `companies` link row.

- When the file's `projects` link is the link of rule `fileProjectsFromEvents` and the removed Event is its only source, whatever the link's state, the hook deletes that link with its source rows and deletes the file's `companies` link of rule `fileCompaniesFromProjects`, with its source rows, whatever its state. The project and company edges are not touched, so both read as the file's own values from then on. The file is announced to clients after the commit.
- When another Event still feeds that `projects` link, the hook removes the removed Event from the sources of a link that is not `on`, and from the sources of a link that is `on` while the file is in the Trash, and announces the file. The engine's hook leaves a target in the Trash alone, so without this the removed Event would stay a source of the trashed file's link and the file would follow it again after a restore. A live link that is `on` is recomputed by the engine's hook, which removes the source and recomputes the projects, so the hook leaves it alone. The hook does not recompute the projects of a trashed file, as the engine does not either. The `companies` link is left alone in all cases, because the file still follows the other Event.
- When the file has no `projects` link, when the link is of another rule, or when it does not name the removed Event, the hook changes nothing. A company that follows a project the file had on its own therefore keeps following it.

The hook is registered in `domainWriteHooks.ts` immediately before `linkRuleEdgeHook`, and that place is part of the decision. The engine's hook deletes the file's `projects` link when the removed Event was its last source; after that a file that just lost the link cannot be told from a file that never had one. The registration is an exception to the rule that entries of a later source go after those of the sources it depends on: the line stays directly before `linkRuleEdgeHook` in every merge that adds entries to that file. A merge that moves it fails the removal tests of `eventAttachmentProjectInheritance.test.ts`.

The lock order of the rows of one file follows [[2026-11-15-a-user-edge-write-on-a-link-rules-via-relation-locks-the-rules-target-item-before-ending-value-links]], which puts the item row before the link rows of that item: the file row, then the `projects` link row, then the `companies` link row. A user or agent removal of the attachment takes the file row in the before-link-break hook of that decision and holds no link row while it waits for it. A removal by a system writer runs no such hook, so the release takes the file row itself, as its first lock. Both are tested.

### What this does not do

- Moving the Event to the Trash leaves the file's company link `on`. The source detach of issue #1656 deletes the file's `projects` link in that transaction and nothing relinks it when the Event is restored. An attachment removed after its Event was in the Trash therefore finds no `projects` link, the hook changes nothing, and the file keeps a company that follows its project. Ending the company link when the Event is trashed needs a Trash hook that is not decided here.
- When the user added a project to the file while it was attached and the removed Event was the only source of the `projects` link, the hook deletes the `companies` link as well, whatever its state. The user's write ended only the `projects` link; the engine made the added project a source of the `companies` link, which stayed `on`. After the removal the company of that project stays on the file as its own value and no longer follows that project. A narrower release would have to tell the Event's projects from the user's on a broken link; the transcript release is unconditional too.
- The order in which a user or agent edge write ends a value link and reaches the file row is not changed here.

## Consequences

A user removal of the file's project (a `Files.projects` edge of a file whose `projects` link is `on`) while the propagation of its Event's project works on the same file settles in both orders in which the two reach the file row, measured by `eventAttachmentProjectInheritance.test.ts` on pools of the runtime role `semprec_data` with a third transaction holding the file row. No order ends with `40P01`:

- the propagation reaches the file row first: the user's removal waits for the propagation, the propagation ends with the busy refusal of the nonblocking relation admission of [[2026-11-01-value-link-relations-use-nonblocking-admission-and-scoped-lock-waits]] (`value_link_busy`) and writes nothing, and the user's removal commits and breaks the link as the user's. Run again, the propagation commits and writes nothing. The test accepts a propagation that commits having written nothing as well: that is no deadlock either, and the user's removal is committed in it too;
- the user's removal reaches the file row first: both commit, and the propagation finds the link broken by the user and writes nothing.

In both orders the file ends with no project, the company it had as its own value, and a `projects` link broken by the user. Both orders were observed three times in a row with the busy refusal in the first and two commits in the second.

Deleting the project edge or the company edge of a file by hand is not affected: the hook runs for `Files.events` edges only, and the test of a removed `Files.projects` edge shows that a link naming a project as its source is not released.
