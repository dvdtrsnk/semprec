---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# The assistant reaches a Journal period through the page operation family

## Context

The assistant reads and writes pages with the operations of [[2026-10-28-page-operation-family]], under the grant
rules of [[2026-11-13-page-operations-follow-the-owner-database-grant]]. A Journal day, week or month is not an item the
assistant can name: the period has to be turned into a Journal item and its page first, and the entry is created lazily
when it is missing (`PUT /api/journal/periods/:type/:period/doc`, the Journal's lazy creation). The sprint summary the
assistant writes for a project goes into such a period. Module agent tools could carry a `journal.read` and a
`journal.write`, but module tools are not yet composed into agent sessions (#1523).

## Decision

**One operation of the page family, `page.ensureJournalPeriod`, turns a period into its entry.** It takes the period
`type` and either a calendar `date` or the canonical `period` key and answers `{ itemId, docId, period, range }`. The
assistant then reads and writes with `page.get` and `page.insert` (`placement: "end"`); writing to the week that
contains 2026-10-16 creates `2026-W42` and appends the text, authored `ai_agent`. A `date` is read as a calendar day of
the system time zone. The operation delegates to the same lazy creation as the REST route, so an existing live entry is
returned and none is duplicated.

It holds `core.item.write` and needs no approval: it creates an empty entry that the user could create themselves and
trash again. An agent needs `write` access to the Journal database, checked before the period is resolved and before
anything is created, in the transaction of the creation (`ensureJournalPeriodForWriter`); the input's own shape (an unknown
type, neither or both of `date` and `period`) is refused at the edge before that.

## Alternatives considered

- Module agent tools `journal.read` and `journal.write`: rejected for now, because module tools are not composed into
  agent sessions yet (#1523). Moving to them later stays possible; nothing is planned.
- Journal operations in the generic catalog (`journal.*`): rejected, the catalog is not the place for them; the page
  family already covers reading and writing the page once the entry exists.

## Consequences

- The catalog grows to 47 operations. The REST equivalent is the existing lazy-creating route of the Journal; no route is
  added for this operation.
- Journal period reads for the assistant (listing periods or events) are not part of this decision.
