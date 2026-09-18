---
status: accepted
date: 2026-09-18
area: [backend]
supersedes: []
superseded-by: null
---

# POST /mcp as a bespoke JSON-RPC transport over GenericOperationGateway

## Context

Issue #220 exposes the 28-operation generic catalog (#219/#252) to Model
Context Protocol clients, in addition to REST and in-process AgentTools.
MCP's wire protocol is JSON-RPC 2.0 framed over HTTP (`tools/list`,
`tools/call`), a different request/response contract than the REST resource
routes `app.ts` otherwise serves: a single JSON-RPC method dispatches by a
`name` field inside the body rather than by URL path, and every response —
including a domain error — is HTTP 200 with the outcome encoded in the
JSON-RPC envelope. Nothing in `services/semprec-api` handled that shape
before this issue, and no existing ADR covers how a second wire protocol
should be layered onto the same process's HTTP surface.

## Decision

`backend/services/semprec-api/src/mcp/mcpHandler.ts` implements the JSON-RPC framing
by hand — parsing and validating the envelope, mapping `tools/list`/
`tools/call` to `GenericOperationGateway`, and mapping the result back to a
JSON-RPC response — rather than adopting a general-purpose MCP server
SDK/framework. `app.ts` routes `POST /mcp` to it as one more exact-path
branch alongside the existing REST routes, the same way `mcpAgentPageHandler`
is already routed; no separate HTTP server or port.

- **Auth is the existing session/Bearer mechanism.** `authenticateRequest`
  (the same function REST uses) resolves the caller; there is no
  MCP-specific credential type. The resulting actor carries only `userId` —
  never `runId`/`agentProjectItemId` — so `GenericOperationGateway`'s
  approval gate is always a no-op for this transport, matching REST's own
  human-actor path; the same gate is not a no-op for the AgentTool
  transport, whose actor always carries both.
- **One dispatch path, three transports.** MCP calls the same
  `GenericOperationGateway`/`GenericApplicationPort` REST (#219) and
  AgentTool (#220's own composition root) call — `mcpHandler.ts` owns only
  request framing and error-to-JSON-RPC-code mapping, never a parallel copy
  of capability gating, approval gating, or choke-point dispatch.
- **`grantedCapabilities` is fixed per process**, not derived per request:
  the schema-core module's own registered capability ids
  (`schemaCoreModuleManifest.ts`), constructed once in `app.ts` and closed
  over by the listener. An authenticated MCP session has no project to
  compute a per-project permission manifest against, unlike an AgentTool
  call, which always resolves one from its run's `agentProjectItemId`.
- **Tool names are namespaced `semprec.<operation>`** (`toMcpToolName`/
  `fromMcpToolName`) so they can't collide with another server's tools in a
  client that aggregates multiple MCP servers; AgentTool names stay
  unprefixed since that catalog is never aggregated with another server's.
- **JSON-RPC errors are HTTP 200** with the failure encoded in the
  response's `error` field (`-32601` unknown tool/method, `-32602` bad
  input, `-32001` approval required, `-32000` any other `ChokePointError`);
  only a transport-level failure (unauthenticated, oversized body, an
  exception the handler didn't anticipate) uses a non-200 HTTP status. This
  follows JSON-RPC 2.0's own convention that a well-formed RPC exchange
  completes at the HTTP layer even when the RPC itself failed.

## Consequences

- A future MCP capability (a third `tools/*` method, resource or prompt
  support) extends `mcpHandler.ts`'s own `if (rpc.method === ...)` chain; it
  does not get a competing implementation of capability/approval gating —
  those stay owned by `GenericOperationGateway`.
- Adopting a real MCP SDK later, if the hand-rolled framing stops being
  enough (e.g. streaming, resource subscriptions), is a transport-layer swap
  inside `mcp/`; it does not change what owns dispatch into the generic
  catalog.
- Any second JSON-RPC-shaped transport this process grows should reuse this
  handler's error-mapping convention rather than inventing its own
  HTTP-status-vs-RPC-error split.
