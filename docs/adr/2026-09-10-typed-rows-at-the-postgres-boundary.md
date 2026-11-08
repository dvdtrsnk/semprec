---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Typed rows at the Postgres boundary

## Context

`pg` types `QueryResult.rows` as `any[]`. Every store function therefore read
untyped rows and handed them straight to a mapper, and TypeScript checked
nothing about the shape in between: a column renamed in a migration, a
`SELECT` missing a column, or a mapper expecting a field the query never asked
for all compiled cleanly and failed at runtime.

The workspace's ESLint configuration acknowledges this directly. The
`@typescript-eslint/no-unsafe-*` family is switched off with the comment that
`pg`'s rows trip them at every call site, that the real fix is "a typed row
layer at the `pg` boundary", and that until one exists the rules would report
the same known gap hundreds of times and drown genuinely new findings.

Unchecked casts at a boundary are the single largest source of high-severity
review findings in this repository, and the review bot is the only thing
catching them — one at a time, after the code is written.

The alternatives were: turn the `no-unsafe-*` rules back on and absorb ~233
reports of one known gap; introduce a bespoke query wrapper that every caller
must adopt; or keep relying on review. The first drowns real findings, the
second adds an abstraction where a type argument suffices, and the third is
what produced the finding rate this decision responds to.

## Decision

Every `client.query(...)` whose rows are read carries an explicit row type
argument: `client.query<SomeDbRow>(...)`. Each module that maps rows declares
that shape once as a named `…DbRow` type, used both by the mapper's signature
and by the query, so the SQL and the mapper cannot drift apart silently.

A single-row read that a mapper consumes goes through `requireSingleRow(rows,
"<what>")` rather than indexing `rows[0]` directly. Under
`noUncheckedIndexedAccess` a typed `rows[0]` is `T | undefined`, which is the
truth: a `RETURNING` clause that matched nothing yields no row, and the guard
turns that into a named error instead of a property read on `undefined`.

This is a convention over a wrapper: no helper to adopt, nothing to route
through, and `no-unsafe-*` can be switched back on per package as each one
stops reporting the known gap.

## Consequences

- The shape a store expects from the database is stated once, checked by the
  compiler, and visible to the next reader.
- Applying it to `packages/data` surfaced 34 places where a row that can be
  absent was passed to a mapper unchecked. None were caught by tests.
- New query call sites cost one type argument. A caller that genuinely does
  not read rows (`BEGIN`, `COMMIT`, DDL) needs none.
- The row types describe what the SQL selects, not the table: two queries over
  the same table with different column lists have different row types, and
  that is intended.
- Turning the `no-unsafe-*` rules back on becomes a per-package decision that
  no longer produces hundreds of reports at once.
