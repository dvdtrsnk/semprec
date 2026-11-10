---
status: accepted
date: 2026-10-28
area: [backend]
supersedes: []
superseded-by: null
---

# Module agent tools: approval classification, project grants and mail sending

## Context

Modules declare `agentTools` in their manifests (`ModuleAgentToolDescriptor`:
name, handler export, optional capability). Today the declaration is only
projected by `ModuleRegistry.getAgentTools`. `createAgentSessionFactoryForRun`
composes only the generic operations and the MCP grants of the run's project,
and `/mcp` exposes only `semprec.<generic operation>`. Composition of module
tools into sessions is #1523, deferral for approval is #1791, MCP exposure is
owned by #1580 (implemented in #1956), per-database grants of projects are
#1810, the mail tools are #1927 and the send flow is #1913. The same rule also
serves the calendar tools (#1957), the Inbox proposal revision tool (#1906) and
approval-gated heartbeat tools (#1846).

[[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]]
exempts non-destructive operations of the generic catalog from approval, and
says explicitly that the exemption does not extend to any other write path:
a module tool that writes outside the generic catalog has no rule yet.
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] is the default
those tools would otherwise fall under. The approval request and the
restricted run credential that carries it over MCP are described in
[[2026-09-18-restricted-mcp-run-credentials-for-approval-gated-calls]] and
[[2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls]].

Sending mail is, in code, `assertEmailSendAuthorized` in `mail/send.ts`: an
agent whose project lacks the project property `emailSendAutonomous` gets a 403
and nothing is queued. The product does not want that outcome: a send by an
agent must be proposed to a human.

In this record "the run's project" is the project item identified by the run's
`agentProjectItemId` (the project the agent was started for). "The thread's
project" is a project set on a mail thread by a human, by an agent or by
Semp's sorting; it never takes part in any rule below.

## Decision

### 1. Classification

Every module agent tool declares two things:

- a **risk class** from the closed risk class set that generic operations, MCP
  and approval requests share (`RiskClass` in
  `backend/packages/shared/src/genericOperations/capabilities.ts`), or none;
- an **approval mode**: `none`, `always` or `unlessProjectPermitted`.

The set currently holds `destructive`. This record adds `outbound`: an effect
that leaves Semprec for a third party and cannot be recalled (a sent mail). The
set stays closed; a further class needs its own decision.

Rules:

- A tool needs no approval (mode `none`, no risk class) when it only reads, or
  when it writes only through operations of the non-destructive generic catalog
  (and so inherits
  [[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]]), or
  when it creates drafts that nothing sends.
- A destructive tool (risk class `destructive`) or an outbound tool (risk class
  `outbound`) needs approval: mode `always` or `unlessProjectPermitted`.
- `always`: every call by an agent run creates an approval request, whatever
  the permissions of the run's project.
- `unlessProjectPermitted`: the call is executed directly only when the run's
  project holds the permission the tool names; otherwise it creates an approval
  request. The permission is read on the run's project, never on a project of
  the data the tool touches. No v1 tool uses this mode for an `outbound`
  effect (section 4).
- A tool that is not classified is not composed into any run. Classification is
  a required declaration, not a default of `none`, because defaulting to "safe"
  is exactly the failure the non-destructive-operations ADR warns against.
- A tool that mixes classes takes the strictest class it can reach.

Alternatives considered: a single boolean `requiresApproval` (as the generic
catalog has) cannot express "approval unless the project is permitted" and
leaves outbound effects undistinguished from destructive ones in the approval
UI and in audits; approval for every module tool (the blanket reading of
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]]) would make read
tools and draft creation unusable for no gain in safety.

### 2. Grants

A module tool appears in a run only when the run's project holds the grant of
the tool's capability. A read tool needs read grants on the module's
databases; a write tool needs write grants on them, both in terms of the
per-database grants of projects in #1810 and both evaluated on the run's
project. A tool without a capability needs no grant beyond the module being
composed.

An ungranted tool is **absent** from the session, not present and denied. The
agent cannot see, name or call it, and no approval request is created for it.
Approval answers "may this granted action run now"; a grant answers "may this
agent attempt it at all", and the two are never merged.

Alternative considered: listing every tool and rejecting at call time. It
teaches the model about tools it cannot use, wastes calls, and turns a missing
grant into noise in the approval queue.

### 3. MCP

Tools are exposed over `/mcp` only to the extent decided by an addendum owned
by #1580. This record fixes what that addendum may not change:

- A run credential gets the same classification and the same grants as the run
  it was issued for, evaluated on that run's project. A tool absent from the
  run is absent over `/mcp` for that credential, and an approval-gated call
  over `/mcp` creates the same approval request.
- A human session (an MCP client authenticated as a user) acts with the user's
  own permissions and is not subject to approval, in line with
  [[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]. No
  project grant applies to it, because there is no run project to evaluate.
- Writes of an MCP client with a human session are still recorded as agent
  (MCP client) writes bound to that user: `writerKind: 'agent'` without run ids
  (#1415). Audits of agent changes therefore include them, and the absence of
  approval never makes them look like manual edits.

Alternative considered: recording a human-session MCP write as a plain user
write (`writerKind: 'user'`). It would hide automated changes from agent
audits.

### 4. Sending mail

Sending is risk class `outbound` with approval mode `always` in v1.

- **An agent run sends:** the call creates an approval request (risk class
  `outbound`) instead of failing with a 403, and nothing is sent until a human
  approves it.
- **An MCP client with a run credential sends:** the same, because the
  credential carries the run's classification (section 3).
- **An MCP client with a human session sends:** it sends as the user, without
  approval, as for any other user action (section 3). This is stated
  explicitly so that nobody reads the approval requirement as covering human
  sessions.

Decided by the product owner: in v1 every send by an agent or by a run
credential goes through approval, **also when the run's project has
`emailSendAutonomous`**. No permission lets a mail leave without approval in
v1. A project written on a mail thread by an agent or by Semp's sorting (the
thread's project) never changes this: it is not the run's project, and no
project property on it is read for a send decision.

This chapter replaces the earlier rule that an unpermitted send ends in a 403
without a queued request (issues #27 and #92). The code keeps that behaviour
in `assertEmailSendAuthorized` until #1913 changes it; this record changes no
code.

Alternative considered: honouring `emailSendAutonomous` through
`unlessProjectPermitted`. Rejected for v1: an autonomous send cannot be
recalled, and a wrong project on a thread must never widen what an agent may
send.

## Consequences

- #1523 composes a tool into a run only after the grant check of section 2;
  #1791 defers calls of `always` and `unlessProjectPermitted` tools through the
  existing approval request and exactly-once execution
  ([[2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls]]).
- #1913 turns the 403 for an agent into an approval request of risk class
  `outbound`; #1927 declares the mail tools with that class and `always`.
- A later descriptor field on `ModuleAgentToolDescriptor` maps to the approval
  mode one to one: `approval: 'none' | 'always' | 'unlessProjectPermitted'`
  plus `riskClass`, with `unlessProjectPermitted` also naming the permission it
  reads on the run's project. A missing field is a validation error at manifest
  load, not `none`. This record does not add the field.
- The risk class set gains `outbound`; its consumers (approval UI, audits,
  `OperationMetadata`) are updated by the issues that implement the tools, not
  here.
- The calendar tools (#1957), the Inbox proposal revision tool (#1906),
  approval-gated heartbeat tools (#1846) and the MCP exposure (#1580, #1956)
  follow these rules instead of deciding their own.
- Audits can rely on `writerKind: 'agent'` covering both runs and
  human-session MCP clients; run ids are present only for runs.
- Using `unlessProjectPermitted` for an `outbound` tool later needs a new
  record that supersedes section 4.
