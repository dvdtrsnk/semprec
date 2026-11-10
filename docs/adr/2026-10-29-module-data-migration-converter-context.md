---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Module data migration converters receive a per-run context

## Context

A module manifest declares a data migration as `dataMigrations`, and
`runModuleDataMigration` applies its converter to every item of one database
for one tenant. The converter runs under the two-pass, row-locked contract of
[[2026-09-28-two-pass-skip-locked-module-data-migration]]: each converter is
idempotent, and the runner rewrites a row only when the converter changes it.

Until now a converter received the item's `properties` and nothing else. It
could not read the tenant's time zone, could not name the item it was
converting, and had no sanctioned way to report a value it left unconverted.
Converting stored Events dates into wall-clock dates and times (issue #1797)
needs all three. The log entry must never carry a property value: the logger's
redaction contract (issue #166) allows identifiers in logs and not property
values.

Alternatives considered:

- **Read the time zone inside the converter.** A converter is synchronous and
  holds no database handle, so it cannot read a setting itself.
- **Pass the runner's client or pool to the converter.** That would give every
  converter query access inside the batch transaction, which the runner does
  not offer.
- **Throw to report an unconvertible value.** A throw rolls back the whole
  batch and stops the migration, which is the wrong outcome for one value the
  converter can leave as it is.

## Decision

The converter has the signature `(properties, context) => properties`. Its
types, `ModuleDataMigrationConverter` and `ModuleDataMigrationConverterContext`,
are declared once in `backend/packages/module-registry/src/registry.ts`, and
the data runner imports them. The context is `{ timezone, itemId, log }`:

- `timezone` is the tenant's configured time zone, read with
  `getSystemTimezone`. The runner reads it once per run that converts items,
  after the per-tenant advisory lock is taken and before the first batch.
  Every item that run converts sees that value. A run that finds the
  transition already recorded, or already held by another runner, reads
  nothing.
- `itemId` is the id of the item being converted.
- `log(reason)` writes one `info` entry on the `migration-job` logger. The
  entry carries `itemId` and `reason`. Inside a tenant scope the logger adds
  `tenantId` itself. The runner passes no other field, so no property value is
  logged by the runner.

A converter that declares only `properties` keeps working unchanged, and the
Tasks 1.0.0 to 1.1.0 converter is unchanged. The runner still writes with a
direct `UPDATE items` guarded by `properties IS DISTINCT FROM`. The context adds
no write path, no choke-point call, no hook and no invalidation. The two-pass,
locking and resumability behaviour of
[[2026-09-28-two-pass-skip-locked-module-data-migration]] is unchanged.

## Consequences

- **The zone is read again on every retry.** A failed run that committed some
  batches and is retried after the tenant changed its time zone converts the
  retry with the new zone. Pass 2 then revisits rows that an earlier attempt
  converted with the old zone. A converter whose result depends on the zone
  must define its result for that case. The runner does not detect it.
- **`reason` is a code, and the runner cannot check it.** The runner only
  passes the item id and the string the converter gave. A converter that
  builds `reason` from a property value breaks the no-value rule. A reviewer
  rejects a `log` call whose reason contains a property value. A reason is a
  short code such as `unparseable_time`.
- **Logs are written per item and per pass.** Pass 1 and pass 2 each call the
  converter once per row, so a converter that logs for every item writes two
  entries per item. A converter logs only when an item needs attention.
- **The context is read-only and carries no database access.** A converter
  that needs a further read is a different design. Adding such a read to the
  context needs its own ADR, because it would give converters a way into the
  batch transaction.
- **Context fields are part of the converter contract.** Adding a field to
  the context is an additive change that existing converters can ignore.
  Changing or removing one is a contract change, and it needs an ADR that
  supersedes this one.
