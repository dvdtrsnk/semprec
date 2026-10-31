---
status: accepted
date: 2026-10-28
area: [backend]
supersedes: []
superseded-by: null
---

# Confirming an MCP card only pre-fills project grants

## Context

The Inbox can propose connecting an MCP server, and the user confirms the
card together with a key. The card also lets the user say which projects
should use the server.

The codebase already forbids any grant write outside the project's AGENT
page. `project_mcp_grants` (new pairs default to `granted = false`) is
written only by `setProjectMcpGrant` in
`backend/packages/data/src/mcp/mcpGrantsAdminStore.ts`, which is kept off the
public surface of `@semprec/data`. The header comment of
`backend/packages/data/src/mcp/mcpProjectGrantsStore.ts` records that agents,
including proposal confirmation, have no write path to grants. The only
human path is
`PATCH /api/projects/:projectItemId/mcp-grants/:mcpToolRegistrationId` in
`backend/services/semprec-api/src/mcpAgentPageHandler.ts`; its sibling
`GET /api/projects/:projectItemId/mcp-grants` already returns each tool's
`riskClass`. Grants only become possible after a sync has registered the
server's tools (the sync runs after the confirm).

The rule existed so that availability (`mcp_tool_registrations`) and
per-project visibility stay independent facts, in line with
[[2026-09-10-agent-writes-are-proposals-not-direct-writes]] and
[[2026-09-10-single-writer-ownership-model]]. Until now it lived only in code
comments. A card that asks "which projects?" invites reading the answer as a
grant, so the stance needs to be a recorded decision.

## Decision

Confirming an MCP server card never grants project access to the server's
tools. This confirms the existing rule in the header comment of
`mcpProjectGrantsStore.ts`; that file and older documents are not edited.

The project selection on the card is only a suggestion: for the chosen
projects, the server's tools of risk class `read` are pre-selected, and the
user then grants them explicitly in the project's permissions (the AGENT page
route above).

Reason: even a read-class tool sends the project's data to a third party, so
every grant must be an explicit act of the user on the grant itself, not a
side effect of confirming a card.

**Invariant later code must keep testing:** no path other than the AGENT page
route (`PATCH .../mcp-grants/:mcpToolRegistrationId`) can write
`project_mcp_grants`. In particular not the confirm route, the post-confirm
sync job, agent tools, or `/mcp` operations.

## Consequences

- No confirm route, proposal envelope, agent tool, `/mcp` operation, run
  credential, heartbeat or queue job (including the post-confirm sync) writes
  `project_mcp_grants`. The AGENT page route stays the only writer.
- The pre-fill is a client concern built from data the AGENT page list
  already returns (`riskClass`). The confirm body and the sync job carry no
  grant selection.
- Tools added by later syncs are not granted either; they appear ungranted on
  the AGENT page.
- `requires_approval` and the risk classes are unchanged. Approval-gated
  calls and the run credentials of
  [[2026-09-18-restricted-mcp-run-credentials-for-approval-gated-calls]] and
  [[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]] are
  unaffected: a grant decides whether a project may see a tool, approval
  decides whether a call may run, and neither implies the other.
- [[2026-10-16-stdio-mcp-confined-to-admin-tenants]] is unaffected; this
  decision governs grants, not which servers may exist.

## Alternatives considered

- **A human confirm grants read and write tools under limits.** Rejected: the
  grant would be a side effect of confirming a card, so the user never acts on
  the grant itself, and write-class tools would reach projects on the strength
  of a connection prompt.
- **A confirm grants read-class tools only.** Rejected: read-class tools still
  send the project's data to a third party, and it would give the confirm
  route a grant write path, breaking the single-writer rule above.
- **Grant at sync time without a human.** Rejected: it removes the human from
  the decision and gives a queue job write access to another owner's data,
  contrary to [[2026-09-10-single-writer-ownership-model]].
