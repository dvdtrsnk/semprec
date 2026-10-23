---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Diagnostic findings/notifications from unattended jobs are not agent proposals

## Context

[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] requires that
agent-originated *changes* go through the approval queue rather than a
direct write, because an unattended agent that can mutate a user's domain
state (tasks, items, guidance, anything a human would otherwise author or
edit) has no point where a mistake can be caught before it takes effect.

That rule predates this ADR, and the codebase already has several
unattended, AI/heartbeat-driven jobs that write directly to their own
bookkeeping tables and notify the user — `agent_run_error` notifications
from `agentRunsStore.ts`, `heartbeat_error` notifications from
`scheduler/sweep.ts`, and similar patterns in the library metadata and mail
sync jobs. None of these go through `confirm`. Applying the proposal rule
literally to this category would make all of them retroactively
non-compliant, which was never the intent — they don't touch any field a
user owns or would otherwise author.

Issue #85's `core.agentGuidanceDrift` heartbeat is the same shape: it
writes rows to `agent_guidance_drift_findings` (its own bookkeeping table,
not a `project_agent_guidance` row or any other user-owned domain state)
and fans out notifications describing what it found. It never edits the
guidance text, the permission manifest, or anything a `confirm` flow would
apply.

## Decision

The proposal/approval requirement in
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] applies to
writes that change user-owned domain state — state a human authored, or
that a `confirm` flow would otherwise apply on a user's behalf. It does not
apply to a job's own diagnostic bookkeeping (finding/error tables scoped to
that job) or to notifications describing what an unattended job observed.
Those may be written directly, in the same transaction as the bookkeeping
row, exactly as `agent_run_error` and `heartbeat_error` already do.

A feature in this category still owns the same discipline: it writes only
to tables it defines/owns (never to another module's domain rows), and any
downstream action a user takes in response — e.g. editing guidance to
resolve a reported contradiction — is a normal user-initiated write, not an
agent write.

## Consequences

- `core.agentGuidanceDrift`'s finding upserts/resolutions and its
  `agent_guidance_drift` / `agent_guidance_drift_resolved` notifications are
  direct writes inside the action's own transactions, consistent with the
  `agent_run_error` / `heartbeat_error` precedent, not a violation of
  [[2026-09-10-agent-writes-are-proposals-not-direct-writes]].
- A future feature that wants to let an agent modify guidance, permissions,
  or any other user-owned state directly (not just report a finding about
  it) still needs the proposal/approval flow — this carve-out does not
  extend to that case.
- Reviewers checking a new heartbeat/agent job against
  [[2026-09-10-agent-writes-are-proposals-not-direct-writes]] should ask
  "does this write change state a user owns/authors, or record what the job
  observed about it?" — only the former requires `confirm`.
