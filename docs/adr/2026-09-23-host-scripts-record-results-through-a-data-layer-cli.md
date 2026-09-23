---
status: accepted
date: 2026-09-23
area: [backend]
supersedes: []
superseded-by: null
---

# Host operations scripts record results through a data-layer CLI

## Context

Issue #178's monthly restore test is a root-owned bash script on the host, not one of the
application's long-running processes. It drives Docker and restic, and on failure it has to write
a `backup_restore_failed` notification through the canonical notification writer
(`notifications/notify.ts`'s `writeNotification`). That writer is the only place that resolves the
recipient's localized title, deduplicates on `(source, kind, transitionInstance)`, enqueues the
push fanout job in the same transaction, and fires the realtime hook after the commit.

The alternatives were: `psql` from the script with a hand-written `INSERT INTO notifications`,
which skips everything `writeNotification` does; or a new HTTP endpoint on `semprec-api` for the
script to call, which adds an authenticated inbound route and credential just so a local script can
reach code it could run itself. The notification also needs a durable source row, and the existing
one for "an operational check is failing" is `observability_checks`, which already feeds the system
health report.

## Decision

A host script that has to record an outcome in Postgres runs a small Node entrypoint compiled into
`@semprec/data`'s `dist/` in the current release (the same shape as `runMigrationsCli.js`), and that
entrypoint calls data-layer functions such as `writeNotification` and
`transitionObservabilityCheck`. The script passes only non-secret, validated arguments; the entrypoint
rejects anything outside its closed argument contract. The restore test's entrypoint is
`observability/restoreTestResultCli.ts`: it keeps the `backup:restoreTest` check (`ok` or
`alerting`) and, on failure, writes one notification per run.

The entrypoint connects with `SEMPREC_SIDE_DATABASE_URL` (`semprec_side`), since it writes only
side tables. It never touches a choke-point table.

## Consequences

The script depends on the current release having been built; a missing or broken release makes
the recording step fail. The script still exits non-zero; a failed run still sends the external
`/fail` ping, and a passing run whose result cannot be recorded sends no success ping, so the
monitor sees a missed check-in. Neither signal depends on the release. The `backup:restoreTest` row has exactly one
writer, the restore-test entrypoint, so it stays under the single-writer model even though the
every-minute `observability.checkSystem` task writes other rows in the same table.
