---
status: accepted
date: 2026-11-13
area: [backend]
supersedes: []
superseded-by: null
---

# A domain adds a row to the related collections of a record through a per-process registry

## Context

`relation.related` (issue #1839) lists the collections connected to a record. Its generic read counts the records
that relations and the manifest area filters connect to the viewed record, but some rows cannot be counted that way:
the mail thread count of a person (issue #1874) comes from mail data, which the choke point must not know by name
([[2026-09-24-choke-point-composed-from-domain-modules]]). The read therefore needs a seam through which a domain
adds a row for a record type.

[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] decides a per-process registry for two
write-time hooks, the item update and the relation edge write. It is a registry of side effects of a write, run in
the write's transaction, and it says nothing about a function that runs on a read and contributes data to its
result. This record decides that case. The grant check it relies on is
[[2026-11-12-per-database-agent-grants]], and the read is an operation of the generic port
([[2026-09-17-generic-application-service-port]]).

## Decision

**The registry is keyed by the database key of the viewed record.** `chokePoint/relatedContributors.ts` exports
`registerRelatedRowContributor(databaseKey, contributor)`, which returns a function that removes the registration,
and `relatedRowContributorsFor(databaseKey)`. A contributor is an async function of
`{ client, itemId, databaseId, databaseKey }` that returns one `RelatedCollectionRow` or `null`. `listRelatedWithClient`
calls the contributors registered for the key of the viewed record's database, in registration order, one after the
other, and only for records of that database. A record of a database without a key has none. A contributor that
rejects fails the read; nothing swallows its error.

**The registry is empty until a domain fills it.** This record creates the seam only. The first contributor, the
mail thread count of people, is delivered by issue #1874.

**Registering the same function twice is not deduplicated.** Unlike the `Set` of the 2026-09-30 registry, the
registry keeps an array: the function is called once per registration, and the remover returned by either
registration removes every entry of that function. This is harmless for the read, because the rows of one database
collapse to one (next rule), and a test or a module registers and removes in pairs.

**A contributed row replaces the generic row of its database.** The row is stored under its `databaseId`, so a
contributor decides the count, the `via` and the `filter` of that database for the viewed record, including when the
generic read or a route (`relatedRoutes.ts`) built another row for it. When two contributors answer for the same
database, the one registered later wins.

**A contributed row passes every filter a generic row passes.** After the contributors ran, a row is dropped when
its count is not positive, when its database is unknown, archived, internal (a system database that is not
client-visible, other than Threads) or omitted by the record type's `relatedOrder`, and, for a reader, when it may
not read the database: an agent's project ([[2026-11-12-per-database-agent-grants]]) or an external AI client on
`/mcp`, which is refused every sensitive database
([[2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases]]). Rows are then ordered by the
record type's declared order. A contributor therefore never has to know about grants, archiving or order, and it
cannot leak the existence of a collection that an agent or an external client may not read. The Threads database keeps its `null` filter,
whichever row built it. The grant check on the viewed record itself runs before any contributor.

**A contributor only reads.** It is handed the `PoolClient` of the transaction that serves the read and must use it
for reads of its own domain's data only. The transaction is not opened read-only, so the contract is a rule of
the contributor, not something the client enforces; a contributor that writes would commit its writes with a read.

**A module registers at load, next to its domain's logic and from the composition point.** The contributor is exported
by the domain module that owns the data, the way a write hook is, and is registered from `domainWriteHooks.ts`, the
side-effect module that is the first import of `backend/packages/data/src/index.ts`. Every process that loads
`@semprec/data` then has the contributor before the first request. That module is also where the registrations of
the 2026-09-30 registry live, so a reader has one place to see what reacts to a record. A test that registers a
contributor of its own removes it again with the returned function.

## Alternatives considered

- Reading the extra rows in `relatedOps.ts` directly: rejected, because the choke point would import the mail domain
  by name, which [[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] and the
  `chokepoint-knows-no-domain` rule exist to prevent.
- Adding the contributors to the `Set` registries of `hooks.ts`: rejected, because those run in a write, take the
  written item and return nothing; a read contributor returns a row and is keyed by a database key.
- A contributor that returns rows to add to, not replace, the generic row: rejected, because two rows for one
  database would give the client two counts for one collection, and the count must equal the number of records the
  returned filter selects.

## Consequences

- A domain adds a related row for a record type with one function and one registration, and no edit to
  `relatedOps.ts`.
- Reading `relation.related` no longer shows every source of a row, only that contributors run; the list is in
  `domainWriteHooks.ts`.
- A contributor sees the full tenant transaction of the read, with the same row-level security as every read, and is
  trusted not to write. Nothing stops a mistake in one until review.
- A slow contributor slows every `relation.related` of its record type, since contributors run in the read's
  transaction one after the other.
