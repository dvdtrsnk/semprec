---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Voice admission is retained until handler settlement

## Context

[[2026-11-04-single-owner-voice-channel-admission]] requires release on close
and bounded shutdown. A WebSocket close does not cancel a JavaScript Promise
returned by onStart, onAudio or onControl. Starting onClose or admitting the
same user while that work remains active can race late allocation and cleanup.
A timeout is neither cancellation nor proof that resources have been released.
The initial channel has no provider handler; later integration must not infer
that transport shutdown terminates its work.

## Decision

Keep the supported single voice-owning API process. Closing a socket stops
new dispatch and prevents further sends immediately. Retain that session's
same-user admission reservation until its active handler callback settles,
then run onClose exactly once. Release admission only after successful cleanup.
An operation rejection still proceeds to cleanup; preserve its failure and any
cleanup failure instead of letting one replace the other.

Do not overlap callbacks for a session. Invoke synchronous handlers directly
and complete their admission turn synchronously, so several valid frames
coalesced into one transport read are not falsely considered async overload.
A genuinely pending or declined handler still follows the existing bounded
close-on-overload contract; no unbounded audio queue is added. Closed-session
callbacks and late completions cannot send or start further protocol work.

Shutdown bounds its wait for operation and cleanup settlement. If either
remains pending, or cleanup rejects, return an explicit failure and retain
fail-closed same-user admission. Do not reinterpret a deadline as settlement,
run cleanup concurrently with active work, or admit a replacement over it.
A later actual operation completion still triggers exactly-once cleanup; a
successful cleanup can then release admission. Failed cleanup retains the
reservation, with no automatic retry that could repeat side effects.

A permanently uncooperative handler can keep that user's admission blocked
for this process's lifetime. There is no JavaScript preemption guarantee,
forced cancellation, timer-based release, new recovery endpoint or provider/
turn cancellation protocol in this delivery. Bounded shutdown means bounded
transport teardown and bounded reporting of unsettled work, not a claim that
an unresolved handler stopped. Existing outer shutdown continues independent
teardown after recording channel failure; no overall clean settlement is
claimed while owned handler work remains unsettled.

This narrowly replaces the earlier release-on-every-close and no-pending-work
interpretation for asynchronous handlers. Other voice limits, privacy,
transport oversize handling, authentication and single-owner restrictions
remain unchanged. Earlier accepted ADR bodies remain historical records.

## Consequences

Controlled real-socket tests hold start, audio or control callbacks across
peer close, deactivation and shutdown. They establish that cleanup follows
operation settlement, same-user replacement is refused while pending, late
completion cannot send, and release follows successful cleanup. Separate
hung-operation, hung-cleanup and rejected-cleanup controls report bounded
failure without false release, while other users remain independent. A real
coalesced-frame control distinguishes synchronous acceptance from genuine
async pressure. These tests do not certify future provider cancellation or
distributed admission.
