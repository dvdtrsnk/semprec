# Batch 27 read-contract reconciliation

## Derived values are explicitly opt-in

Gh-1595 Context, Task3 and acceptance define requesting derived first and links additionally. Resolve its contradictory shorthand test in favor of BOTH flags for derived link entries. No hidden derivation for links-only queries, no derived field without opt-in. Test all four combinations on actual generic/REST read owners; preserve legacy manual/value links and manual stored edges, derived authoritative only when opted in, batch query behavior and tenant isolation. No runtime scope union across members or new framework is authorized.

## Resolved notification ties

Gh-1559 adopts the new standalone ADR for exclusive timestamp/id keyset continuation with canonical microsecond output and bounded validated inputs. Optional afterId plus required since, at most500 own rows, nextCursor from the last returned tuple or null on empty. No Date precision loss or timestamp-only advancement through tied pages, no resolution-writer/schema/lock/client change or global server cursor. Current rows are deterministically traversed; cross-request late commits with older timestamps are explicitly outside this read's guarantee, not claimed solved. Raise the source tier from low to medium as an owner-directed reassessment of this new protocol; aggregate tier stays high. The named store function's root star export is authorized with exactly its public-surface catalog entry and real notificationsHandler tests. No extra public runtime helper.

Exact source and aggregate snapshots/approvals and manifest hashes are regenerated together; outer acceptance is unchanged. Both decisions are server-only and candidate-local verification still must exercise the production entrypoints and relevant failure/privacy branches. No runtime gate or acceptance authorized by metadata alone. Gh-1662 creation-time concurrency/owner admission remains a separate pending decision; do not invent its lock or claim race safety. Plain CREATE INDEX IF NOT EXISTS for gh-1567 is already permitted and matches transactional migration runner; no extra concurrent-index mechanism.
