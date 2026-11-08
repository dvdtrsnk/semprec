---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# AI usage call aggregates share one statement snapshot

## Context

The public `getAiUsageReport(Queryable, input)` read model accepts both a pool
and a transaction client. Independent queries for its rows, model and operation
breakdowns, total and calendar series can observe different committed call
states. A reservation or settlement between statements can therefore produce a
report whose parts disagree. Gh-1472 and gh-1477 require consistent totals and
shares. Account start also depends on the earliest call and determines the
monthly series, so it participates in this consistency requirement.

A READ COMMITTED transaction would still give separate statement snapshots.
Wrapping only the HTTP route in REPEATABLE READ would leave direct public
callers inconsistent. Requiring a pool or opening a hidden transaction around a
supplied client would change the public ownership contract. This decision adds
a read-model snapshot boundary without changing
[[2026-09-29-withtransaction-is-the-sole-transaction-opener]].

## Decision

`getAiUsageReport` will obtain its call-dependent results with one parameterized
SQL statement: native/run-unit rows, per-model groups, merged-operation groups,
reservation flag, total, daily or monthly call series, and account start. The
account-start expression retains the tenant-scoped minimum user creation time,
minimum call time, LEAST semantics and existing empty-account fallback. SQL
aggregation returns grouped report output; it does not download raw call history
for aggregation in JavaScript. New row and JSONB shapes are validated at the
database boundary.

Preserve the existing Queryable signature, tenant scope and RLS, range and
timezone rules, calendar zero fill, null/unit rules, operation aliases, ordering
and fields. Preserve the existing status rules for each component: failed calls
are excluded from rows and breakdowns; this decision does not change the
historical daily/monthly series filters. Timezone, catalog and budget metadata
may retain their existing separate reads. The report does not promise that this
metadata and the call statement describe one simultaneous database state.

Compute each exported cost aggregate, including merged operation costs and the
report total, with SQL numeric aggregation before converting that aggregate to
the public JavaScript/JSON number. Use that report total as the denominator for
operation shares, retaining zero-total shares of zero. Cost-sum equality means
the same underlying numeric accounting sum; separate binary-number conversions
and a caller's floating-point reduction need not be bit-identical. The stored
numeric column has no fixed scale: add no currency rounding, residual
redistribution or decimal-place policy. Fractional tests must check explicit
expected aggregates and narrowly account for binary representation; a broad
monetary tolerance must not hide a mixed snapshot.

## Consequences

The SQL read is more involved, but consistency applies to existing pool and
client callers without a new transaction API, writer lock, cache or isolation
override. An already-open transaction retains its own isolation semantics.

Tests will overlap a runtime-role report read and an independently committed
accounting write using actual operation PIDs and bounded owned coordination.
They will distinguish complete old and new call states, cover account start and
calendar results, and include fractional costs. These are targeted snapshot
claims, not global transaction serialization or production load guarantees.
