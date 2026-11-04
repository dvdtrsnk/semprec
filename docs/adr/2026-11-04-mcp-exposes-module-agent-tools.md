---
status: accepted
date: 2026-11-04
area: [backend]
supersedes: []
superseded-by: null
---

# Bounded MCP exposure of run-compatible module agent tools

## Context

Gh-1580 extends
[[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]].
[[2026-10-28-module-agent-tools-approval-and-grants]] fixes classification
and actor permissions; [[2026-11-04-owned-databases-admit-safe-module-agent-tools]]
provides conservative current project admission and defers general grants to
gh-1810 and gated calls to gh-1791. Existing module handlers take a persisted
run id, and heartbeat handlers derive their project from that run. Human MCP
sessions have no run or project. Restricted credentials currently encode only
closed core capability ids. Neither module activation nor a fabricated actor
can fill those missing contracts safely.

## Decision

Gh-1580 initially exposes run-compatible module tools only to validated
restricted run credentials. A common data-owned resolver serves agent
sessions and MCP; extract the existing resolution, active rule-kind wiring,
argument/result validation and invocation rather than copying it into the API.
It computes current permissions for the actual persisted run/project in its
trusted tenant. MCP additionally intersects capability-bearing tools with the
credential and process grants. The session continues to receive its existing
project-admitted set. No-capability tools still require active composition and
safe classification, and their owners retain their own project guards.

Only safe `approval:none` definitions are admitted. Always and
unlessProjectPermitted tools remain absent. Non-core capability-bearing tools
cannot be represented by current restricted credentials and remain absent
over this initial MCP surface, even when visible to an internal session.
Do not widen credential storage or implement another grant provider here.
Gh-1810 and the later exposure owners must reconcile credential representation
before such tools can be exposed; gh-1791 retains gated execution ownership.

Human MCP generic operations remain unchanged. Run-only module tools are
absent for human actors in this bounded implementation. This explicitly
defers human-compatible module adaptation; it does not claim the full human
module surface of the earlier decision has been delivered. No project grant
is evaluated for a nonexistent human run, no run is invented, and no human
module write is silently authorized. Later domain exposure in gh-1956/gh-1957
must define a real actor-compatible contract under the original user's
permissions and agent-write attribution. Gh-2018's heartbeat visibility work
is not included.

List and call use the same current actor-specific resolver. Hidden and unknown
names return the same -32601 response. Detect collisions with generic names
across all active module declarations at listener creation, including names
hidden by capability or approval filtering. Names are `semprec.<toolName>`.
Use actual module argument schemas. A validated returned module error becomes
MCP text content with `isError:true`; a successful result has false. Thrown
validation, approval and domain errors retain the existing specified JSON-RPC
mapping. Unknown failures retain safe existing handling, with no provider text.
Native pi event adaptation remains service-specific under
[[2026-11-04-module-tools-preserve-refusals-and-native-error-results]].

## Consequences

Real restricted-credential heartbeat.list supplies the positive MCP/session
parity case. Test core-capability intersection, non-core/gated absence,
unknown/hidden equivalence, actual tenant/project isolation, authentication
before lookup, active declaration collisions, schemas and error results.
Retain human and restricted generic-operation regressions. Export only the
actual common resolver needed across packages and maintain its exact public
surface expectation. Do not introduce a general actor framework or new
descriptor defaults. This narrows initial delivery only; prior ADR bodies
remain immutable and future candidate exceptions do not transfer.
