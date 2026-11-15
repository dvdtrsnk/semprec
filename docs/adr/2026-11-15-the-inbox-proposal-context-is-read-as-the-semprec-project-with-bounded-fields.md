---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The Inbox proposal context is read as the Semprec project and carries a fixed set of fields

## Context

[[2026-11-01-bounded-workspace-ids-for-inbox-proposals]] gave the proposal computation a read of five built-in
databases that discloses only an item's id and name, and left two things to gh-1987: the read through the
per-database grants of [[2026-11-12-per-database-agent-grants]], and the facts a good proposal needs (the capture
moment, the timezone, the previous state of a card), under the 1 MiB body limit of the AI gateway
([[2026-09-10-ai-gateway-monopoly-on-provider-calls]]). This decision delivers those and widens the disclosure of that
decision by the fields below. It does not replace the relation-membership, the caps on relation targets or the
operation checks of that decision, which stay as they are.

## Decision

The context is read as the Semprec project, the project of the tick's heartbeat (`ProposalComputationInput.projectItemId`).
`readProposalWorkspaceContext` asks `listUnreadableDatabaseIds` for the databases that project may not read and
produces no group at all for such a database: no empty list, no placeholder, no count. A database the user marks
sensitive therefore contributes nothing until a grant exists for that project, and a grant for one project does not
open it for another. The read runs in the one short read transaction of the computation and writes nothing.

Each kind carries only these fields, every text cut at 100 characters: projects `id, name, status, areaId`, areas `id,
name`, people `id, name, relationship`, companies `id, name, registrationNumber` (the `ico` property), events `id, name,
type, date`. A project's `areaId` is set only when the area is live and its database is readable for the project. At
most 20 entries per kind are read (`CONTEXT_LIMIT_PER_KIND`), ordered as in the earlier decision. The five kinds are the
whole disclosure: a grant for the Health records database does not add its records, because they are not a kind of the
context.

The request also carries the capture facts (`captureDate`, `captureTime`, `captureChannel` when set, the tenant
`timezone` and `today` in it), the item's `text` or, when that is blank, its `transcribedText`, and for a recompute the
`aiProposal`, `history` and `userEditedKeys` of the existing card that are set. The system message tells the model to
resolve relative dates against the capture moment and to write rewritten Markdown only inside text properties.

The serialized context (text, facts, catalogs, workspace and previous state) is held to 900 KiB, which leaves the rest
of the 1 MiB for the system message and the other lines. When it is over, workspace entries are dropped kind by kind
in the order events, companies, people, areas, projects, the last entry of a kind first, which is the one the reader
ranks lowest. The item text, the facts and the previous state are never cut; a context that is still over the budget
with an empty workspace is sent as it is, and the gateway refuses the request only when its body exceeds its own 1 MiB
limit.

## Alternatives rejected

- Check the grant in the gateway before the call. A check outside the read's transaction can disagree with the read,
  and the data layer already owns the decision ([[2026-11-12-per-database-agent-grants]]).
- Send an empty group or a count for a closed database. It tells the model that
  the database holds records.
- Cut the item text to fit. The text is what the person wrote; a request that cannot fit it is a failure to report,
  not a text to shorten silently.

## Consequences

A built-in database that is marked sensitive disappears from the context for a project without a grant, and the
proposal can no longer pick records of it. The status, relationship, registration number and event type and date of
listed records now reach the model. The previous state of a card is not bounded by the budget: a card with a very large
history can make a recompute fail at the gateway.
