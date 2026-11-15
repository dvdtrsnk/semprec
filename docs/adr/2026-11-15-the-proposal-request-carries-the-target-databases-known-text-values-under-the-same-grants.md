---
status: accepted
date: 2026-11-15
area: [backend]
supersedes: []
superseded-by: null
---

# The proposal request carries the known text values of the target database under the same grants

## Context

[[2026-11-15-the-inbox-proposal-context-is-read-as-the-semprec-project-with-bounded-fields]] fixed what the proposal
computation of an Inbox item discloses about the workspace: five kinds of built-in records with a fixed set of fields,
read as the Semprec project through the per-database grants of [[2026-11-12-per-database-agent-grants]], and it calls
those five kinds the whole disclosure of the workspace context. A model that fills a form of the target database
(Health records, say) with only that context invents option keys and spells a person differently each time. It needs the
options of the database it proposes into and the values the person already wrote in its text properties. The values are
data of the target database, which is not one of the five kinds, so they are a disclosure that decision does not cover.
It does not change the workspace context, which stays as that decision describes it.

## Decision

For the one database a proposal is computed into, the request carries a target catalog
(`buildTargetCatalog`, `proposalTargetCatalog.ts`), in a block of its own between the lines `<<<TARGET_OPTION_CATALOG`
and `TARGET_OPTION_CATALOG>>>`:

- `selects`: for every user-owned `select` and `multi_select` property, its stored option keys with the label in the
  user's `users.locale` (`cs`, English for any other value), resolved through the owning module's catalog like
  `GET /api/schema`. This is schema, so it is sent whatever the reader may read.
- `textValues`: for the first five user-owned `text` properties, up to 20 distinct values with the number of live items
  holding each, read through `computeDatabaseFacets`, the read behind `database.facets`. A value longer than 100
  characters is left out, not cut, because a cut value would be proposed as if it were the stored one. The 20 is a
  bound, not a quota: the facets read cuts to its 20 most frequent values first and the length rule then removes from
  those, so fewer than 20 are listed when a frequent value is long. A `title` property is another property type and is
  never read, so no title is disclosed.

The values are read only when the Semprec project, the reader of the workspace context, may read the target database
(`listUnreadableDatabaseIds`). Otherwise the block carries the options and no values. A built-in database marked
sensitive, Health records included, therefore contributes its values only after a grant for that project, and a grant
for one project does not open it for another. The block is omitted when the database has no select property: the block
grounds the choice of option keys, and the Task of gh-1990 adds no block for a database without one, so the known text
values of such a database (Companies, say) are not sent. The read runs in the one short read transaction of the
computation and writes nothing. The system message says the block is data and that a select value must be a listed key
and a text value should reuse a listed one. Values and labels are stored data, so the one JSON line is written with `<`
and `>` as the JSON escapes `\u003c` and `\u003e`: a stored value that holds a delimiter cannot end the block early, and
every value and key reads back exactly as stored.

## Alternatives rejected

- Send the values whatever the grants say. The values of a sensitive database would reach the model although the user
  closed the database to this project; the options are schema, the values are the person's records.
- Send the values of every text property. The count of properties and the length of a value are unbounded, and a long
  text is a note and not a value to reuse; the five properties and the 100 characters keep the block small beside the
  900 KiB budget of the context, which counts it.
- Read the values with a query of its own. `database.facets` already counts live items only and has one answer for what
  the most frequent values of a property are.

## Consequences

For Health records without a grant the model gets the option keys and none of the values, so it may spell a subject
differently from the stored ones; with a grant the subjects of existing records (names of people and pets) reach the
model. A text value of another database that has at least one select, is in use and is short enough reaches the model for
every proposal into that database. A proposal into a database chosen by the model itself (a recognition of an untyped
item, an operation of a multi-step answer) carries no catalog of its own for that database.
