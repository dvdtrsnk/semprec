---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Transcript values are inherited by link rules, whichever process writes the edge

## Context

A transcript linked to an Event takes over the Event's project and
participants and, through the project, the company, and follows them until a
user or Semp changes the value (issue #1697). The Transcripts `event` edge has
several writers in three processes: `semprec-transcribe` writes it in its
create step ([[2026-11-10-transcription-create-writes-the-uploads-event]]) and
in its match step
([[2026-09-23-transcription-worker-writes-event-match-results]]);
`semprec-api` writes it when a transcript card is confirmed and through the
generic relation endpoint; `semprec-agents` writes it for Semp's
`relation.put`.

[[2026-09-23-transcription-worker-writes-event-match-results]] limits the
worker to the writes it names and states that any further write it needs is a
new decision.
[[2026-11-05-transcription-create-writes-requested-project]] added the
requested project. [[2026-09-10-single-writer-ownership-model]] requires an
explicit ownership handoff before a second process writes a field.
`Transcripts.project`, `Transcripts.company` and `Transcripts.people` are
`owner: user`.

The link-rule engine (issues #1411, #1593) already copies a source value to a
target when a via edge is written, records a value link, and carries later
source changes in a queued job. Its hooks are registered through
[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]].

The alternatives were a job that asks `semprec-api` to copy the values after
the edge commits, which leaves a linked transcript without its values and
splits the write over two transactions, or copying code inside the
transcription module, which would be a second mechanism next to the link
rules.

Two product decisions shape the result. The tenant's own person, the Event's
organizer, is never copied into a transcript's people. After the Event is
disconnected or moved to the Trash, the project, the company and the people
stay as the transcript's own values.

## Decision

The `systemDatabases` manifest declares three link rules:

- `transcriptProjectFromEvent`: `Events.project` to `Transcripts.project`, via
  `Transcripts.event`;
- `transcriptPeopleFromEvent`: `Events.people` to `Transcripts.people`, via
  `Transcripts.event`, with a value filter that leaves out the own person;
- `transcriptCompanyFromProject`: `Projects.company` to `Transcripts.company`,
  via `Transcripts.project`.

The rules run in the process and in the transaction that writes the via edge.
The engine's edge-changed hook is registered by `domainWriteHooks.ts` in every
process that loads `@semprec/data`, so the first copy and its link rows are
written by `semprec-transcribe`, `semprec-api` or `semprec-agents`, whichever
wrote the edge. A later change of a source value is carried by the
`valueLinksPropagate` job, which has the `api` task affinity.

This extends the limit of
[[2026-09-23-transcription-worker-writes-event-match-results]]: the write
surface of `semprec-transcribe` grows by the rule-driven value writes that
follow its own `event` and `project` edge writes, which are the three target
relations and their value-link rows, and by nothing else. That ADR is accepted
and is not edited.

Ownership handoff: the three target relations stay `owner: user`. The
`valueLinks` process writes them, as a system writer, only while the value
link of that item and property is `on`; the choke point refuses the write
otherwise. A user or agent write that changes the value ends the link, and a
system write never does. A rule fills only an empty property: a property that
already holds a value keeps it and gets no link.

A link rule may carry `valueFilter: { omit: { databaseKey, propertyKey } }`.
It names a relation property of a singleton system database; the items that
relation points to are left out of the values the rule copies. `databaseKey`
is the database's owner module id (`systemSettings`), because the System
settings database has no `databases.key` and no manifest declares it. The
filter is applied when the edge hook copies or recomputes the values, in the
propagation job and on a relink. A filter that cannot be resolved in the
tenant's schema leaves the whole rule unresolved, and a relink of its link
answers `409`: nothing is copied unfiltered. The manifest schema checks the
filter's shape and the seeded-schema drift check its property; the registry's
database-key validation does not cover it, because it knows only databases a
manifest declares.

A change of the relation the filter names is carried to the values copied
before it. The own person is usually chosen after the first recordings were
matched, and it can be changed or cleared later. When that relation gains or
loses an edge, the engine's edge-changed hook queues the `valueLinksPropagate`
job for every source of an `on` link of the filtered rule, in the transaction
of that write, and the job recomputes those links with the filter as that
transaction commits it. A link that is broken is not queued and not written.

A copy and a change of the filter's relation exclude each other through the
row of the filter's database, the System settings row. Reading the omitted
items locks every row of that database `FOR SHARE` before it reads their
edges, and keeps the lock to the end of the transaction that copies.
`setSelfPersonId` locks the row `FOR UPDATE` before it writes the edge, and
for any other writer of the relation the engine's hook locks it `FOR UPDATE`
before it reads the links to queue. A copy at READ COMMITTED, the level
`withTransaction` uses unless a caller asks for another, therefore either
reads the relation as the change committed it, or commits its link before the
change reads the links, so the recomputation covers it. A copy inside a
transaction with a fixed snapshot (`repeatable read` or `serializable`) reads
the relation as of that snapshot and has no such guarantee.

A rule copies only live items from a relation source. The Trash keeps an
item's edges and a relation write refuses an endpoint that is in the Trash, so
an Event's trashed project or participant would otherwise fail the write of
the via edge in whichever process writes it, the transcription worker
included. The first copy, the propagation job and a relink leave such an item
out. This holds for every link rule with a relation source, not only for the
three declared here.

The company follows a replaced project. `Transcripts.project` is the target of
one rule and the via edge of another, and the propagation replaces it by
deleting the old edge and creating the new one. The link engine (issue #1593)
deletes a link whose last source goes with its via edge and keeps the value as
the target's own. Applied to that delete, it would end the company link and
leave the previous project's company on the transcript. The engine's removal
rule therefore depends on who removed the via edge:

- When the `valueLinks` process removed it, in the propagation job or in a
  relink, the edge was an inherited value that is being replaced or cleared.
  The engine clears the target's inherited value, as `valueLinks` and while
  the link is still `on`, and then deletes the link. The via edge that process
  writes next finds an empty target and links it to the new source.
- When a user, an agent or another system process removed it, nothing
  changes: the link is deleted and the value stays as the target's own.

The engine tells the two apart by the propagation context of
[[2026-11-05-value-link-propagation-keeps-separate-hop-budgets]], which is set
on the writing client around every propagated value. A relink sets it around
its relation writes as well, with hop 0, the budget of an ordinary root write.
A system write made on that client inside the context counts as the
`valueLinks` process's, also when a hook of another domain makes it in
reaction to the propagated write; the hop count already attributes such a
write to the propagation. The rule applies to every link rule whose via edge
is itself an inherited value, not only to the transcript's company. A link
that is not `on` is not touched by it.

The company link ends with the Event. The transcript's `project` edge stays
when the Event goes, so the rules alone would keep the company following the
project. An edge-changed hook for the removal of a Transcripts `event` edge
and an item delete hook for Events
([[2026-11-07-item-delete-and-restore-domain-hooks]]) delete the `company`
value link of each affected transcript with its source rows, in the
transaction of that removal or trash. The company edge is not touched. No
restore hook is registered.

The same edge-changed hook detaches the removed Event from the transcript's
`project` and `people` links, whatever their state, and deletes a link that
is left without a source. The link engine does this only for a link that is
`on`. A link the user or Semp had broken would keep the Event as its source:
the value would read as inherited from an Event the transcript has no edge
to, and a relink would make the transcript follow that Event again. The trash
of an Event needs no such step, because the source detach of issue #1656
removes a trashed item from links of any state. After either, no link of
that transcript names the Event, and a relink of a property whose link is
gone answers `409`.

## Consequences

- `semprec-transcribe` and `semprec-agents` read the link rules on a
  relation edge write, through the full module registry that the engine loads
  and keeps per process.
- A transcript whose project was written by the worker's create step gets
  that project's company as an inherited value in the same transaction,
  because the rule for the company follows the transcript's `project` edge
  whoever wrote it.
- When the Event's project changes, the transcript's project and company
  change with it. When the Event loses its project, the transcript loses its
  project, its company and its company link; a project the Event gets later
  brings both values back.
- A user who replaces the transcript's project by hand disconnects the old
  project: the company stays as an own value and does not follow the project
  the user chose, unless the company was empty at that moment.
- A company the user or Semp had changed is not touched when the project is
  replaced, because its link is broken. That broken link keeps naming the
  project the company was first taken from, so a relink of the company takes
  that project's company, not the current project's.
- The release of the company link does not look at where the project came
  from or at the link's state. It also ends a link that follows a project the
  user chose on the recording card, and a link the user or Semp had broken;
  the company then reads as own.
- The release locks the `company` link row and takes no lock on the
  transcript row, as the source detach of issue #1656 locks only link rows, so
  it adds no wait on a transcript row to the trash of an Event. A link that
  still has a source after its item sources were removed fails the
  transaction, so the edge removal or the trash rolls back with it.
- On the removal of an `event` edge the hook also locks the transcript's
  `project` and `people` link rows, in that order and before the `company`
  link row. A link that another source still feeds keeps that source and its
  state.
- A transcript that is disconnected from its Event and linked to another one
  takes the new Event's values into every property that is empty, also into a
  property whose link the user or Semp had broken before the disconnect,
  because that link is gone.
- Restoring the Event relinks nothing: the edge to the restored Event is
  still there, and the values stay own.
- Nothing is backfilled. A transcript whose `event` edge was written before
  the rules existed got no value link from that write, so it takes over
  nothing from that Event.
- In a tenant whose System settings has no `selfPerson` relation, the people
  rule is unresolved and copies nothing; the drift check reports it as
  `missingValueFilterProperty`.
- Reading the omitted items reads and share-locks every row of the filter's
  database. A filter over a database that is not a singleton would read and
  lock all of its rows on every copy.
- A transcript linked before the own person was chosen keeps that person
  among its people until the queued job has run, not until the choice
  commits.
- Choosing, changing or clearing the own person queues one job for every
  Event that feeds a people link that is `on`, whether or not that Event has
  the person among its participants, in the transaction of that write.
- The first copy, the propagation job and a relink of a filtered rule wait
  for a transaction that holds the System settings row `FOR UPDATE`, and
  `setSelfPersonId` and any other update of that row wait for the copies that
  are in flight. The hook takes its lock after the relation edge and the
  jobs of earlier hooks are written, so no lock order is claimed for a writer
  other than `setSelfPersonId`: PostgreSQL may end one of two such
  transactions with a deadlock error, and that transaction rolls back as a
  whole.
- A value that is in the Trash is not copied, and a target that already held
  it loses that edge the next time its link is recomputed. Restoring the item
  queues nothing: the targets get it back with the next change of the same
  source property, or with a relink.
- The live items are read without a lock. An item moved to the Trash by
  another transaction between that read and the relation write is still
  refused by the write, and the writing transaction rolls back as a whole.
