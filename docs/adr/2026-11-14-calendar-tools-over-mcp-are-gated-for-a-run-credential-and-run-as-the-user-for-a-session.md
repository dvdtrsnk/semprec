---
status: accepted
date: 2026-11-14
area: [backend]
supersedes: []
superseded-by: null
---

# Calendar tools over MCP are gated for a run credential and run as the user for a session

## Context

Gh-1957 exposes the three calendar write tools (`calendar.respondToInvitation`, `calendar.placeTaskInEvent`,
`calendar.removeTaskFromEvent`, capability `calendar.write`) to agent sessions and to `POST /mcp`.
[[2026-11-04-mcp-exposes-module-agent-tools]] left every tool with a module capability, every approval-gated tool and
every human-session module tool absent over `/mcp` and named gh-1956 and gh-1957 as the owners of the contract.
[[2026-11-14-mail-tools-over-mcp-run-as-their-run-or-as-the-session-user]] (gh-1956) delivered the contract for the
tools of a module that opts in with `mcp: { humanHandlerExport }`: the run credential stores the module capability ids
the mint accepted, a tool is offered to a run credential when its own list names the capability and the run's project
holds it, and a human session runs the tool's human handler as its user. That record requires such a tool to have
`approval: "none"` and no `requiresApproval`, which every mail tool satisfies and the calendar write tools do not:
[[2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request]] leaves the creation of the
approval request over `/mcp` to gh-1957, and [[2026-09-10-agent-writes-are-proposals-not-direct-writes]] makes every
calendar write of an agent a proposal. [[2026-10-28-module-agent-tools-approval-and-grants]] section 3 fixes that a run
credential gets the classification and grants of its run, an approval-gated call over `/mcp` creates the same approval
request, and a human session acts with the user's permissions, is not subject to approval and is recorded as an agent
write without run ids.

## Decision

1. **The calendar tools opt in to MCP like the mail tools.** Each declares `mcp: { humanHandlerExport }` in the calendar
   manifest, and `calendar.write` is a capability id of the calendar module, so the mint of
   [[2026-11-14-mail-tools-over-mcp-run-as-their-run-or-as-the-session-user]] accepts it into a credential's list. No
   capability is admitted from the project's grants alone: a credential whose list does not name `calendar.write`, such as
   one restricted to `core.item.read`, neither lists the tools nor files a request, and a call is the "method not found"
   of an unknown name. The project's grants stay the other bound, as in an agent session.
2. **This narrows one rule of the mail record.** The manifest schema allows `mcp` for a tool with a capability that is
   either `approval: "none"` without `requiresApproval`, or declared with `requiresApproval`. A tool with `approval`
   other than `none` and no `requiresApproval` is still refused, because only the flag makes the endpoint defer a call.
   Everything else in the mail record stands.
3. **A run credential's call of a gated tool files the request.** `/mcp` resolves the run's tools with
   `includeApprovalGated`. A tool declared with `requiresApproval` is listed, and a `tools/call` of it validates the
   arguments, creates the `moduleTool` request through `createModuleToolApprovalRequest`, the path an agent session uses,
   and answers the approval-required error (-32001) without running the handler; the handler runs once the owner approved
   the request. The request carries no tool call id, so every call files its own request. This delivers what
   [[2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request]] left to gh-1957 for every
   gated tool a run credential reaches, not only the calendar tools; a gated tool whose capability is a module's own
   is reached only when it declares `mcp`, as for any module tool.
4. **A human session runs the calendar tools as the user, without a request.** A session has no run, so no request can
   be filed for it, and [[2026-10-28-module-agent-tools-approval-and-grants]] section 3 says it is not subject to
   approval, the same as its mail send. `resolveModuleAgentToolsForUser` therefore returns a gated tool that declares
   `mcp` (its human handler), and the endpoint calls it without a request. Its answer to an invitation is sent to the
   organizer at once. The tool types coexist: the endpoint's resolved tools are `{ kind: "run" }` with the run's tools,
   which carry the approval flag, or `{ kind: "user" }` with the session's tools, which cannot be gated.
5. **Approved calendar writes are agent writes.** A run's handler runs the owning route handler with the writer
   `{ writerKind: "agent", agentRunId, agentProjectItemId, onBehalfOfUserId }` and no human writer (the route handlers take
   the writer as an optional second argument and default to the user, so the routes are unchanged), so every write hook
   sees an agent and the per-database grants of the run's project apply to the Events, Tasks and Calendars databases. A
   human session's handler writes as `{ writerKind: "agent", externalClient: true, onBehalfOfUserId }`, the marker of
   [[2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases]] and no run, as section 3 of
   [[2026-10-28-module-agent-tools-approval-and-grants]] requires. The approval authorises the call; it does not turn the
   write into the user's own edit, which is the difference from a mail send
   ([[2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user]]). The invitation's `status`
   and `respondedAt` stay written by the calendar module's owner process, as the route writes them. The executor passes
   no `approvedRequestId` to a module tool, so a write a deferral rule gates for an agent under a run (a value link, a
   recurrence) would end the approved call as failed instead of running; the three calendar writes reach none of those
   rules.

## Alternatives considered

- **Admit `calendar.write` from the project's grants through a fixed list in the endpoint, with a credential storing core
  ids only.** Rejected: it is the mechanism the mail record already replaced. A list in the endpoint knows each module's
  capabilities, a credential's list would no longer be the upper bound of what it may do, and every later module would
  edit the endpoint again.
- **Defer a call over `/mcp` only for the tools that declare `mcp`.** Rejected: gh-1957 asks for the approval
  requirement of a module tool to be honored over `/mcp`, and a gated tool with a core capability or none is already
  reachable by a run credential once the endpoint can defer it, so the opt-in would only hide the tools that declare no
  module capability.
- **File a request for a human session's call.** Rejected: a request belongs to a run, which a session does not have, and
  the accepted decision is that the user's own session is not subject to approval.
- **Record the approved writes as the approving user.** Rejected: it hides the agent's change from audits and from hooks
  that treat a human writer differently, against section 3 of [[2026-10-28-module-agent-tools-approval-and-grants]].

## Consequences

- A user who mints a credential for a project that holds the calendar databases chooses `calendar.write` with the core
  ids it needs. A credential minted before this decision lists no module capability and so exposes no calendar tool, the
  closed default.
- The grant of `calendar.write` over `/mcp` is as current as the project's database ownership; revoking it removes the
  tools from the next list and call, and the approval executor resolves the tool again before it runs.
- An external AI client with a human token can answer an invitation, and so send the reply email, without an approval,
  as it can send mail; a deployment that must gate it has to mint a run credential instead.
- The gated tools without a module capability (`heartbeat.create`, `heartbeat.update`, `heartbeat.setEnabled`), which
  [[2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request]] kept absent over `/mcp`, are
  now listed and deferred there for a run credential, as they declare no capability.
- A later calendar tool (gh-1952 `calendar.read`) opts in the same way.
