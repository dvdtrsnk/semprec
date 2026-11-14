---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# An attachment inherits the project of its thread by a link rule, and a thread merge repoints the links before it moves the edges

## Context

A file that a mail message brings becomes a Files item at ingest (`mail/attachments.ts`), linked from the message by
`Emails.attachments` and with no project. It should take the project of the message's thread, follow later changes of
that project, and stop following when a user or Semp sets the file's project by hand (issue gh-1898).

`Files.projects` is `owner: user`. [[2026-09-10-single-writer-ownership-model]] requires an explicit ownership handoff
before a second process writes a field; [[2026-11-11-action-item-tasks-inherit-project-and-people-by-link-rules]] and
[[2026-11-14-a-task-made-from-a-mail-thread-inherits-its-project-and-people]] made that handoff for rules whose source
is an Event or a Threads item and whose target is a Tasks or Transcripts value. Neither names a Files target.

A thread merge (`reassignThread`, issue #1573) moves every relation edge of the losing Threads item to the winner with
`transferMailThreadRelationsWithClient`: for each edge it runs the delete hooks, deletes the edge, then runs the create
hooks of the new edge. The link rule hook (`valueLinks/linkRuleEdgeHook.ts`) removes the losing item from the sources of
the link on the delete and, when that was the link's last source, deletes the link and leaves the target's value as the
target's own. On the create it links a target only when the target holds no value yet.

## Decision

**The relation.** `Threads.attachments` is a one-directional `one_to_many` relation to Files, Threads being the "one" side,
`owner: system` with the `emails` process as owner, the process that writes `Emails.attachments`. The shared Threads
builder creates it for a new tenant; `runThreadAttachmentsCutoverMigration` (registered in
`db/tenantCutoverMigrations.ts`) adds it to a tenant that has Threads without it and changes nothing else. Files that
exist keep their values and get no edge.

**The rule.** The mail manifest declares `fileProjectFromThread`: `Threads.project` to `Files.projects`, via
`Threads.attachments`. Ownership handoff: `Files.projects` stays `owner: user`, and the `valueLinks` process writes it
only while the file's link for that property is `on`.

**The ingest.** `ingestAttachments` writes the `Threads.attachments` edge from the message's Threads item to each Files
item it creates, as the `emails` process, in the transaction of the message. The rule hook runs inside that write: it
inserts the `on` link of `Files.projects` with the Threads item as its source, also while the thread has no project, and
copies the thread's project when it has one. The link row is therefore written by the rule and not by `ingestAttachments`.
A file attached to a draft from an existing Files item gets no `Threads.attachments` edge, so it gets no link and keeps
its own project.

**The merge.** `reassignThread` calls `repointThreadAttachmentLinks` before it moves the edges of the loser: it locks the
files attached to the loser in item id order, the order the rule hook takes them in before it locks a link, and moves
the item sources of the links of this one rule from the loser's Threads item to the winner's
(`moveValueLinkItemSources` with `ruleKey`). A link that a user ended is repointed too and keeps its state, so a
relink reads the winner's project. After the move it queues `valueLinks.propagate` for the winner (`propagateThreadAttachmentLinks`).

The repointing comes first because the generic move would otherwise remove the loser's source and delete every `on`
link of the loser's files, which would keep the project they have and follow nothing. With the sources already on the
winner, the delete hook finds no source of the loser to remove, and the create hook finds an `on` link with the winner as
its source and recomputes the file's project from the winner. A file whose attachments edge is moved before the
winner's own project edge arrives is recomputed from the project the winner has at that moment, which can be none, and
the propagation job queued by the project edge and by the merge corrects it after the commit; until that job has run,
such a file can hold no project.

## Alternatives rejected

- **Repoint after the generic move, as the issue lists the steps.** An `on` link has been deleted by then (see above), so
  the loser's attachments follow nothing, and only links that a user ended survive to be repointed.
- **Repoint every link that names the loser (`moveValueLinkItemSources` without a rule).** It would also move the sources of
  the links of tasks made from the thread (`taskProjectFromThread`) and of any later rule over Threads, which this decision
  does not cover.
- **Write the link row in `ingestAttachments` itself.** The rule hook already writes it in the same transaction; a
  second write of the row of `(item, property)` would only duplicate it.
- **A backfill of existing attachments.** Decided against by the issue; they keep their values.

## Consequences

Every message with attachments needs the `Threads.attachments` relation in the tenant: ingest of such a message fails
with an error that names the relation when it is missing, before a byte is stored. A tenant gets the relation from the
cutover above.

A merge of two threads queues one propagation job for the winner when the loser had attachments with this rule's links.
Another rule over `Threads` whose `on` links must survive a merge must repoint them the same way: the generic move
deletes an `on` link whose last source is the loser.
