---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Commit MCP connection observations independently

## Context

Gh-1450 requires the last invocation connection outcome to survive rollback of
its caller. `mcp_server_connection_state` is a tenant-scoped observation keyed
by server, separate from the MCP server item's sync-owned status. It keeps one
current observation, not an append-only attempt history.

[[2026-09-27-auto-committed-writes-for-records-that-must-survive-a-failure]]
requires a `Pool` for independently committed records, but limits its pattern
to append-only rows. Citing it alone does not cover this last-state UPSERT.
This decision extends that mechanism only for the named observational table;
it does not supersede or edit the older record. Batch acceptance must verify
the required implementation and evidence separately.

## Decision

`recordMcpConnectionSuccess` and `recordMcpConnectionFailure` take a `Pool`,
not `Queryable` or a caller's `PoolClient`. Each executes one logical UPSERT
through the pool in the active tenant scope, independent of an enclosing
caller's transaction. The normal scoped-pool wrapper may use its own short
transaction to set tenant context; that does not join the caller's transaction.
`getMcpConnectionStates` remains a read that may use `Queryable`.

A connection success records `last_connected_at` and clears the prior error.
A classified connection failure records only the fixed allowed reason and
preserves the previous successful connection time. A tool-call failure after
successful connection does not make that connection a failure. A failed record
write stays best-effort: it must not change the invocation result or expose
provider content or credentials through diagnostics.

The row represents independently recorded connection observations, rather
than a business mutation whose truth depends on the caller committing. An
observation remains valid after that caller rolls back. Preserve existing RLS,
role grants and explicit tenant scope; this grants no elevated access and no
new writer to the sync-owned MCP item fields. No ordinary item, relation,
proposal, grant or other transactional business write may use this exception.

## Consequences

- An independently committed observation survives caller rollback; callers
  requiring atomic composition with their transaction cannot use these writers.
- The public writer signatures reject transaction clients in typed code. This
  is not an arbitrary-JavaScript sandbox or proof against deliberate type bypass.
- Best-effort recording can leave stale state after a failure. The UPSERT keeps
  no complete history and gives no total ordering or freshness guarantee for
  overlapping connection attempts. No retry, lock, history table or scheduler
  is added by this decision.
- The existing schema remains unchanged. Public getter timestamps must match
  their declared string/null contract; default driver Date values are mapped
  and checked at the read boundary, not asserted to be strings.
- Tests must exercise real invocation and tenant-scoped recording independently
  of caller rollback, distinguish connect failures from tool-call failures,
  and retain runtime-role isolation and failure-preserves-result evidence.

## Alternatives considered

- Use the caller's transaction client: rollback would erase an observation that
  the requirement intentionally retains.
- Add append-only attempts: fits the older ADR directly but adds history,
  retention and read-model work outside the specified last-state requirement.
- Update sync-owned item status: conflates independent observations with the
  sync writer and violates its ownership boundary.
- Treat the old ADR as covering every auto-committed update: rejected because
  it would silently remove its explicit append-only limitation for unrelated
  transactional business state.
