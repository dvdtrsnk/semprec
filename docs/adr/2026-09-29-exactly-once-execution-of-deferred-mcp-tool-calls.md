---
status: accepted
date: 2026-09-29
area: [backend]
supersedes: []
superseded-by: null
---

# Exactly-once execution of deferred MCP tool calls via stale-claim settlement

## Context

[[2026-09-18-exactly-once-execution-of-approved-destructive-operations]]
closed the exactly-once gap for the five destructive generic operations by
running claim, mutation, and terminal write inside one locked transaction:
`ApprovedOperationExecutor` row-locks the `approval_requests` row, performs
the mutation, and writes `succeeded`/`conflict` before that same transaction
commits, so a crash before commit simply leaves the row `queued` for
graphile-worker's retry and a crash after commit has nothing left to redo.
That ADR explicitly scoped itself to the generic-operations path and called
the pre-existing `claimApprovalRequestExecution` guard a "stopgap" for the
mcpInvoke path, without designing that path's own protocol.

The mcpInvoke path cannot use the same single-transaction shape. Its
external step — `executeMcpInvocation`'s `tools/call` over the MCP SDK — can
take up to `MCP_TOOL_CALL_TIMEOUT_MS` (60 s) plus connect time, and neither
the SDK client nor `connectMcpServer` can be driven from inside an open
Postgres transaction without holding a `PoolClient` (and its lock) idle for
that entire external round trip. `claimApprovalRequestExecution` therefore
has to commit the claim (`executed_at` set, `execution_status` still
`queued`) in its own transaction *before* the tool call runs, then
`recordApprovalRequestOutcome` writes the terminal state in a second,
separate transaction afterward. That split reopens exactly the failure mode
the generic-operations ADR's single-transaction design was built to close: a
worker process that crashes (or loses its database connection) between the
claim commit and the outcome write leaves the row permanently claimed —
`queued` with `executed_at` set — with no later delivery able to tell
whether the tool actually ran.

Issue #693's task is to close that gap without being able to remove its
cause: introduce a way to recognize a claim that has outlived any delivery
that could still be holding it, and settle it to a terminal state instead of
leaving it stuck forever.

## Decision

**A claim → external call → record-outcome state machine**, distinct from
the generic-operations path's single-transaction shape.
`handleApprovalRequestExecuteTask` dispatches by payload kind before
claiming anything (`approvalRequestExecution.ts`): a generic-operation
payload still goes through `ApprovedOperationExecutor`'s locked transaction
unchanged; an mcpInvoke payload runs three separate transactions —
`claimApprovalRequestExecution` (claim), `executeMcpInvocation` (the
uncommitted external call, outside any transaction), and
`recordApprovalRequestOutcome` (terminal write) — accepting the crash window
between the first and third as the tradeoff for not holding a database
transaction open across a 60 s external call.

**Time-based stale-claim detection and settlement.**
`settleStaleApprovalRequestClaim` (`approvalRequestsStore.ts`) is the
recovery half of that tradeoff. A `null` claim from
`claimApprovalRequestExecution` is ambiguous by itself — rejected, unknown,
still genuinely in flight, or claimed by a delivery that died — so
`settleStaleApprovalRequestClaim` disambiguates by comparing `executed_at`
against `MCP_APPROVAL_CLAIM_STALE_AFTER_MS` (10 minutes, chosen comfortably
above the 60 s `tools/call` timeout plus connect time, so a claim can only
be that old if the delivery that made it is gone). It returns one of three
verdicts the caller handles differently: `"settled"` — the claim was older
than the threshold, and this call just wrote it to `execution_status =
'conflict'` with a fixed "unknown outcome" `execution_result_jsonb` marker,
so the row is terminal and safe to leave; `"in_flight"` — the claim is
younger than the threshold, so a delivery may genuinely still be running,
and the caller throws a retriable error so graphile-worker's backoff
re-delivers the job later (giving the claim time to either complete or age
past the threshold); `"not_claimed"` — the row was never in the
stale-claimed state (rejected, unknown, or already terminal), unchanged from
the pre-#693 behavior of returning silently.

**Idempotency-key forwarding as the server-side complement to the DB-side
claim guard.** The DB-side claim (`executed_at` set exclusively) prevents
*this* process from invoking the tool twice for the same request, but says
nothing about a server that itself retries or double-delivers a call it
received. `executeMcpInvocation` forwards the claimed request's id as
`_meta.idempotencyKey` on `tools/call` (`mcpToolExecution.ts`) — the
MCP-permitted request-metadata slot — purely so a de-duplicating server has
something stable to recognize a redelivered call by. This process never
re-sends a request it has already claimed; the key exists for the remote
side's benefit, not this process's own correctness.

**`recordApprovalRequestOutcome` returning `boolean` instead of throwing.**
Because the claim and the outcome write are now separate transactions with a
stale-claim sweep able to run between them, a second, legitimate writer can
reach `recordApprovalRequestOutcome` for the same row: the original delivery
finishing late after `settleStaleApprovalRequestClaim` already terminalized
it as `conflict`, or two outcome writes racing after a redelivered claim
somehow both ran. Every write in `approvalRequestsStore.ts` this function
performs is guarded on `execution_status = 'queued'`, so a write against an
already-terminal row affects zero rows; returning that as `false` (rather
than throwing on zero rows, the pre-#693 behavior) lets the caller log a
discard and move on, which is the guard that stops a late-arriving real
outcome from overwriting a stale-settled row's terminal state.

## Consequences

- The crash window between `claimApprovalRequestExecution` and
  `recordApprovalRequestOutcome` is not eliminated, only bounded to
  `MCP_APPROVAL_CLAIM_STALE_AFTER_MS`: a request whose delivery dies mid-call
  settles to `conflict` (with the "unknown outcome" marker distinguishing it
  from an ordinary revalidation conflict) no earlier than that threshold
  after the claim, never immediately.
- A future deferred-call path that also can't hold a transaction open across
  an external call (another provider's tool-call protocol, a webhook-style
  callback) should reuse this claim/stale-settle/record shape rather than
  inventing a new one — extending `settleStaleApprovalRequestClaim`'s
  pattern to a new terminal-state table, not re-deriving the disambiguation
  logic from scratch.
- Any new caller of `recordApprovalRequestOutcome` (or an equivalent
  targeted-UPDATE-returning-boolean function) must treat `false` as an
  expected, loggable outcome — never assume the write always applies, since
  a stale-claim sweep can terminalize the row out from under it.
