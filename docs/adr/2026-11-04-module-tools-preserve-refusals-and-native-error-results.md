---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Module tools preserve refusals and native error results

## Context

[[2026-11-04-owned-databases-admit-safe-module-agent-tools]] admits the
existing own-project heartbeat trigger as write/none only with enabled,
event-rule and active-work guards. R1 found that the legacy agent factory
instead deliberately permits an active run and coalesces repeated pending
manual triggers. Changing its default would change callers outside the new
module composition.

The installed pi-agent-core public API provides `afterToolCall` overrides.
A resolved tool execution otherwise gets `isError:false`, even when its
validated module result has `details.error:true`. Throwing would activate
Semprec's infrastructure-failure abort path rather than return an ordinary
error to the model.

## Decision

The Schema Core module owns a factory wrapper selecting the existing manual
enqueue owner's `refuseWhileActive:true`. Extend the existing trigger factory
with a bounded optional configuration, defaulting to its legacy behavior.
The new module descriptor selects the wrapper; existing callers retain their
default and pending-job coalescing. Reuse the existing heartbeat reservation,
running-run and waiting-job checks, enabled/event checks, enqueue transaction
and rule-kind registry. Map the existing typed active-work refusal to the
existing safe message. Add no queue, lock or scheduler mechanism, and export
no additional heartbeat helper through the data package root.

Session composition explicitly identifies module tools that actually survive
name deduplication. The pi session adapter uses public `afterToolCall` only
for those tools to set `isError:true` when their validated returned details
contain `error:true`. Preserve an existing SDK error, content, details and
usage. This happens before the SDK constructs its model tool-result message
and native completion event, so both representations receive the error flag.
Do not infer module identity from a name prefix or arbitrary call arguments.

Returned module errors remain model input and do not throw or abort the
session. Existing handling of thrown infrastructure failures stays intact.
No SDK mutation, generic/MCP result-policy sweep, invented event identity or
new approval kind is authorized by this decision.

## Consequences

Prove actual module calls refuse running and waiting work without enqueueing,
and preserve eligible success, project isolation and legacy repeat behavior.
Use the real SDK agent loop with a local stream fixture to assert both the
model history and native result event, including success and returned-error
cases. Preserve existing generic/MCP and thrown-failure tests. No live model
or provider call is required.

These are bounded gh-1523 repairs. The prior ADR bodies remain unchanged;
gh-1791, gh-1810 and gh-1580 retain their separate future ownership.
