---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Agents startup repair requires a quiesced predecessor

## Context

Existing startupRepair treats non-MCP running runs as abandoned when the agents process starts. Extending it to running Semp messages does not establish which process owns a live run. There is no database-backed exclusive agents-instance fence in this checkout. [[2026-11-06-semp-recovery-does-not-infer-worker-death]] preserves queue locks rather than inventing that missing evidence.

The agents systemd unit also has no explicit TimeoutStopSec. Host manager defaults cannot define a portable application stop deadline.

## Decision

The supported local gh1732 startup topology is one owning semprec-agents service instance per database, with its predecessor quiesced before repair starts. Multiple task slots and the dedicated/general runners inside that instance remain supported. API and transcribe processes are separate consumers and are unaffected.

This is an explicit operational precondition, not a runtime fence, PID proof, heartbeat oracle or automatic takeover mechanism. Deployment must establish predecessor quiescence externally before starting repair. Overlapping agents startups, rolling multi-instance takeover and global fencing of live tool writes are unsupported OPEN production concerns; no local test or empty process registry proves them safe. Add no attestation environment flag or fictional successful exclusivity check. Preserve ordinary non-Semp repair behavior.

Pin the repository agents unit TimeoutStopSec to 120 seconds. Its Semp turn grace deadline is 90 seconds from shutdown entry: 120 seconds minus a named 30-second cleanup margin. Listener closure, queue drain/abort, interrupted-message persistence, idle-session closure and pool end must retain their owners and fit that ordering. Code uses named constants tied to this contract, not an inferred host default or arbitrary per-test timeout.

A turn completed before the grace deadline is done normally. At the deadline abort the still-running Semp controllers, settle their message error/interrupted write before closing the pool, and preserve real persistence/cleanup failures. Do not declare interrupted persistence successful merely because a timeout elapsed. Keep the existing idle-session close after queue settlement while the pool is open. Any needed dedicated-chat runner abort configuration must align with this deadline; do not change general/non-Semp task behavior.

This authorizes repository unit/configuration changes and deterministic tests only. It does not reload systemd, alter a running host manager or attest the deployed value on this Mac.

## Consequences

Startup recovery is usable only under the explicit single-owner/quiesced-predecessor condition. Immediate dead-only queue unlock and multi-instance fencing remain unimplemented, rather than hidden behind an assumed lease. Validate the unit value and named deadline/margin together, cover finishing and deadline-aborted turns plus failure settlement, and retain deployment/overlap limitations in the final evidence.
