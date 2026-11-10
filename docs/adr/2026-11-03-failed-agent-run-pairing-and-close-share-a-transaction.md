---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Failed agent run pairing and close share a transaction

## Context

The gh-1568 recovery first tries to pair dangling tool uses and then closes a run. The current pair helper catches a pairing failure; closing afterward makes the missing tool result unwritable and startup repair no longer selects that terminal run. SempConversation also publishes a terminal status separately from its close transaction.

This extends [[2026-09-29-withtransaction-is-the-sole-transaction-opener]] and [[2026-09-10-side-effects-follow-the-commit]] for the failure close of a driven run. Existing idle startup/shutdown rules and MCP credential lifecycle remain unchanged.

## Decision

For runAgentSessionForRun and SempConversation failRun, use one failure-close owner: lock the run through the existing getAgentRun(client, id, true), confirm it is still running, read its persisted events, insert the regular synthetic results for its dangling uses, close with finishAgentRunWithErrorNotification, and append the terminal run_status only when that close wins. All those database effects share one transaction/client. Post-commit announcements keep the existing data-owned callbacks. A terminal run already closed by another owner is left unchanged; this path does not repair or rewrite historical terminal runs.

A Pool opens that short database-only transaction through withTransaction. A supplied PoolClient must belong to an active managed transaction, checked through the existing requireManagedTransaction mechanism; it does not open or commit a nested transaction. On failure in that supplied-client recovery, mark that managed invocation rollback-only with the existing mechanism, so catching a JavaScript failure or rolling back a savepoint cannot commit partial pairing. Expose only the existing ownership/rollback-marker functions needed by this cross-package caller; do not redesign the pool owner.

Pairing errors are not swallowed before terminalization. A failed pairing or close rolls back the group, including notification and pending callbacks. With a Pool, the durable run remains running for an eventual successful startup repair. A supplied owner rolls its surrounding work back. Do not claim an immediate next wake after a failed database recovery; ordinary successful failure/cancellation recovery still supports the required immediate next wake. No automatic retry, new timer, queue, or session replay is added.

When recovery succeeds, rethrow the exact original session/cancellation failure. If recovery also fails, surface an AggregateError whose first member and cause are the original thrown value and whose second member is the recovery failure, preserving identity even for undefined and non-Error values. A diagnostic failure cannot replace either. Retain existing safe diagnostic policy; no raw user/provider content is added to shared logs. This narrowly replaces best-effort pair-then-close behavior; it does not change ordinary success closing or declare every external close owner serialized.

## Consequences

Use real run/session and SempConversation tests for successful recovery and injected pairing/terminalization failure. Verify exact original/secondary identities, no partial synthetic/terminal/notification effects on rollback, managed-owner catch/commit refusal, and later successful startup repair plus actual next send. Existing close races and false-close behavior remain covered. This transaction does not span provider latency, guarantee cancellation of an arbitrary iterator, cover heartbeat owners which do not enter these two paths, or promise recovery while the database remains unavailable.
