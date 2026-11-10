---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Stream the full behavior window before one bounded gateway comparison

## Context

Gh-1629 requires exact distinct-run groups from a fourteen-day event window.
The initial reader rejects more than 1,000 events or any payload over 65,536
bytes. The actual event owner accepts payloads up to 1 MiB, so these smaller
limits discard valid inputs before their qualifying group is considered.
Keeping every run id in application Sets would remove those limits at the
cost of memory proportional to the whole window.

The existing snapshot under
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
and shared typed tool-event parser stay in place. Cursor lifetime remains
inside [[2026-09-29-withtransaction-is-the-sole-transaction-opener]]. The gateway still receives one complete comparison, outside the
transaction, followed by the existing locked revision recheck. This decision
selects bounded local scanning, not a new queue, persistent aggregate, parser,
provider policy or generic database/cursor framework.

## Decision

The data usage owner opens one uniquely named NO SCROLL, WITHOUT HOLD server
cursor on its supplied managed snapshot transaction. Fetch at most sixteen
rows at a time. It reads the entire fixed fourteen-day window for the tenant's
project, with the same lower/upper bounds, not an event-count prefix. The
existing 1 MiB event-writer limit is unchanged; read valid payloads above the
former 64 KiB threshold without rejecting their size.

Sort by a raw candidate subject key (generic operation or MCP registration,
target database), run id, then exact event timestamp and id descending. The
candidate key orders rows only: the actual shared parseToolEventPayload still
decides validity and canonical subject. Invalid/legacy events without identity
are skipped as before; do not duplicate the parser's validation in SQL. Keep
full timestamp precision for ordering and evidence rather than round-tripping
through a millisecond Date cursor key.

Rows for a subject/run are contiguous. Count a run once after its first valid
row, without a Set containing every run. Keep only the current subject/run,
its count and the twenty most recent distinct-run evidence entries, plus the
bounded fetch and completed qualifying groups. Pick group display metadata
from its most recent valid event. Preserve exact counts and most-recent
ordering when runs/events cross fetch boundaries. The minimum-run and
window constants live in the existing neutral shared guidance contract;
application exports remain compatible.

Only qualifying groups are retained for the comparison. Incrementally bound
their model-input projection by 1 MiB, the existing non-image gateway request
ceiling. This projection excludes run-id evidence, matching the actual model
input. Including serialization overhead, validate the complete encoded request
against that existing ceiling before calling the gateway once. No gateway or
response cap is increased. If the complete input cannot fit, fail the behavior
pass explicitly before gateway/reconciliation; never truncate groups, silently
choose a subset or treat unfinished input as an empty result. The permission
pass retains its independent execution/error behavior.

This is a declared representability/resource limit of one gateway request,
not a replacement raw-event count/size limit. A large number of duplicate or
nonqualifying events must not itself reject a valid qualifying group. Database
timeouts and other real resource failures remain failures, never partial PASS.
Do not promise completion for arbitrarily large input within fixed time.

The cursor is transaction-bound, never WITH HOLD, and closes on normal return;
errors preserve the primary error and allow the managed rollback to release an
aborted cursor. Do not mask a failed statement with a CLOSE on an aborted
transaction. No cursor survives commit/rollback or pool release. Generated
cursor identifiers must be demonstrably closed server-generated identifiers,
not caller strings; bind query values normally. No new dependency, shared
configuration change, read-role bypass or persistent staging table is needed.

## Consequences

Node memory is bounded by a fetch, current-group evidence and the representable
qualifying output, rather than all events/runs. PostgreSQL owns the ordered
scan and its normal configured sort resources. This adds a private cursor
lifecycle, not a global pool facility; the existing snapshot has no external
network/model work inside it.

Real runtime tests must reproduce the former 1,001-event and 70 KiB failures,
then prove full qualifying results, repeated runs across fetch boundaries,
latest-twenty evidence, malformed/legacy skipping and tenant separation.
Composition tests must prove one behavior call and persisted finding on valid
large inputs, no finding/resolution on incomplete or oversize input, and owned
cursor settlement after success/error. Keep prior failure logs immutable.

PostgreSQL documents transaction-bound cursor behavior in
[DECLARE](https://www.postgresql.org/docs/current/sql-declare.html). Actual
implementation and lifecycle correctness still require the repository tests.
