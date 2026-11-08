---
status: accepted
date: 2026-09-24
area: [backend, cross-cutting]
supersedes: []
superseded-by: null
---

# Rollback repoints `current` one release back; migration compatibility is checked mechanically

## Context

[[2026-09-24-immutable-releases-behind-an-atomic-current-symlink]] keeps every prior release on
disk as a complete directory, and [[2026-09-10-expand-contract-forward-only-migrations]] makes
every migration backward compatible so a rollback never has to unwind schema. Issue #191 adds the
rollback itself and asks for the migration discipline to be checked where it can be.

Two things had no decision yet. Which release may a rollback target? Expand/contract only promises
that the code _one_ release back still works against the migrated schema: a contract step in
release N removes what release N-1 already stopped using but N-2 may still read. And how is that
promise upheld? Until now only the reviewer read each migration for it.

The alternatives for the target were "any release on disk" (simple, but lets an operator start
N-2 against a schema it may not read) and recording the applied schema version in the database
and matching it per release (exact, but a second version scheme next to the release tags).
Undoing migrations (down migrations) was ruled out by the Task.

## Decision

- **Rollback is `deploy.sh --rollback <tag>`.** It builds nothing, fetches nothing and runs no
  migration: it repoints `current` at `releases/<tag>` with the same atomic `rename(2)` swap,
  restarts the same services and checks each process reports `<tag>`.
- **Only one release back.** `<tag>` must be the complete release directly before the newest
  release on disk (versions compared as semver; hidden staging directories never count), its
  `release.env` must declare `APP_VERSION=<tag>`, and `current` must still name that newest
  release. The newest release on disk is the newest whose migrations ran, so this is the one
  target expand/contract guarantees. Every refusal happens before anything changes.
- **No schema is ever unwound.** A defect that needs a schema change is fixed forward: a new
  migration in a new release, deployed normally.
- **Migrations are checked lexically.** `findIncompatibleStatements`
  (`backend/packages/data/src/db/migrationCompatibility.ts`) flags a dropped table or column, a
  rename, a column type change, `SET NOT NULL`, and a new `NOT NULL` column without a default,
  except on a table the same file creates. A unit test runs it over every migration; it fails
  the build unless the file carries `-- expand-contract-exemption: <reason>` (a contract step, a
  widening type change, or a break the issue's Task calls for). Concrete accepted and rejected
  examples live in `backend/packages/data/src/db/migrationExamples/`, and an integration fixture
  applies each one on top of a previous-release schema and runs that release's queries against it.

## Consequences

- Rolling back twice in a row is refused. Once `current` is the previous release, the next step is
  a fix-forward deploy, not an older release.
- A deploy that failed while migrating leaves no release directory, so the rollback cannot see
  the migrations it already applied. If one of them was a contract step, the release one back from
  the newest on disk may not run against the schema any more; the way out is forward, not back.
- A migration that is safe for a reason the lexical check cannot see needs a written reason in the
  file, which the reviewer then judges. A statement the check does not model (for example one
  built by `EXECUTE` from a string) is still only caught in review.
- `0025_auth_schema.sql`, written before any release existed, is the one existing migration the
  check does not accept; the test lists it by name rather than exempting a range.
