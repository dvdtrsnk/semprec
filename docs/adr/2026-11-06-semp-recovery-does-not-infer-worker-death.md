---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Semp startup recovery does not infer a queue owner's death

## Context

Gh1732 requested immediate release of dead Semp queue owners while preserving live owners. Installed Graphile Worker 0.17.3 persists WorkerPool.id, not an individual worker.workerId, in job and queue locked_by. Its supported force_unlock_workers function clears all locks of the supplied owner IDs; it does not establish whether those owners have died. This checkout has no authoritative cross-process pool-death registry. Process heartbeat age, a claimed job, an absent connection, or a pool-ID string cannot supply that missing proof.

The [official administration contract](https://worker.graphile.org/docs/admin-functions) requires independently established owner death before force unlock, and the [0.17 release notes](https://worker.graphile.org/releases) document the pool-ID change. This is a narrow safety disposition of the recovery deferred by [[2026-10-28-semp-thread-turns-run-on-a-per-tenant-chat-lane]], not a replacement queue protocol.

## Decision

Do not add automatic force unlock at agents startup. Preserve Graphile-owned job and queue locks and its existing stale-lock expiry. In particular, neither a startup repair nor a missing process heartbeat may call force_unlock_workers or directly clear locked_by/locked_at. No liveness registry, lease, PID mapping, database-session advisory lock or fencing framework is introduced here.

The original desired latency requirement, immediate dead-only lane release without waiting for Graphile expiry, remains explicitly OPEN/NOT RUN for production. This parent-approved local scope does not implement or prove it. A later implementation needs separately authorized positive owner-death evidence and protection against a still-executing owner after connection loss; a heartbeat table alone would not establish that. Local implementation acceptance must carry this gap rather than declare reduced-delay recovery PASS.

Continue the independently implementable gh1732 repair of abandoned running assistant messages and bounded shutdown. Existing startup run repair assumes the previous owning agents process has stopped; this change establishes no support for overlapping agents startups or globally fenced tool writes. Other API/transcribe queue consumers are unaffected and never unlocked.

Add only the missing nullable text error_code column on semp_messages through a next-free additive migration. Existing rows remain null; the interrupted transition writes interrupted with status error in the same repair transaction. Do not backfill, reclassify other failures, or change agent_runs.error_code. Existing RLS, grants and table ownership stay unchanged.

## Consequences

A dead chat owner may still hold its lane until Graphile expiry. That availability gap is visible and does not justify risking duplicate tool writes from a live owner. Tests prove ordinary message repair/idempotency and shutdown, and verify that existing queue/job lock identities and timestamps remain unchanged; they do not claim immediate dead-owner recovery. Old deployment binaries and true process-death detection remain separate evidence, not simulated PASS.
