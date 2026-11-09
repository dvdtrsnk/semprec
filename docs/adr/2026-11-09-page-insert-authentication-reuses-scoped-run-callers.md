---
status: accepted
date: 2026-11-09
area: [backend]
supersedes: []
superseded-by: null
---

# Page insert authentication reuses the scoped run-credential caller

## Context

The #1679 Task asks for `ai_agent` as the author when the request carries an agent run credential, "the same
detection the MCP gateway uses". The routes of the shared JSON adapter ([[2026-09-11-module-manifest-custom-routes]])
authenticate a session (`authenticateRequest`) and build a person as the actor; their identity requires a session row,
which a run credential does not have. An agent could therefore insert only through `/mcp`
([[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]).

## Decision

`POST /api/items/:id/page/insert` is served by its own listener (`pageMarkdownHandler.ts`), like `page.md`. It accepts
two kinds of caller and no other:

1. A bearer token that `resolveRunCredentialCaller` (`mcp/callerActor.ts`, the code `/mcp` uses for the same step)
   resolves to a run credential. The caller is an agent run (`runId`, `agentProjectItemId`), the tenant is the
   credential's, and the write is dispatched through `GenericOperationGateway.invoke` with the credential's capability
   set intersected with the process's granted set. An operation the credential does not hold answers like an unknown
   one (404); the stored update is authored `ai_agent`. The token lookup runs in the one scoped system lookup the
   resolver already owns, and the target data is read inside the verified tenant.
2. Anything else is authenticated exactly as an adapter route is: the session cookie or a session bearer through
   `authenticateRequest`, dispatched as a person and authored `user`. A bearer token that is neither a credential nor a
   session is 401.

Only `page.insert` gets this listener. No capability or grant is added or widened, the body is capped at 1 MiB and
checked strictly, and errors use the adapter's closed error contract.

## Consequences

- `/mcp` and the insert route resolve a credential with one function; a change to the credential rules applies to both.
- A second route family that wants run-credential callers needs its own decision.
- A project agent holds `core.page.write` only through an explicit grant, so the route does not give agents page
  writes they did not have through `/mcp`.
