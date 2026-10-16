---
status: accepted
date: 2026-10-16
area: [backend]
supersedes: []
superseded-by: null
---

# A stdio MCP server can only be stored by a human admin of the current tenant

## Context

An `mcpServers` item whose `connectionConfig` has `transport: "stdio"` names a host
`command`, `args` and `env`, which the connection factory spawns as a child of
`semprec-api` or `semprec-agents`. `connectionConfig` is an `owner: "user"` property, so
every writer could store one: a REST user, an external MCP client over `/mcp`, an agent
through the `item_create` and `item_patch` AgentTools, and a Semp proposal. With several
users that is remote code execution on the host for anyone, and for any model that can be
prompted.

[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] lets a domain hook
validate an update inside its transaction, and [[2026-10-09-item-create-domain-hooks]] does
the same for a create, but the hook contexts carried no writer, and
`AuthenticatedActor` could not tell a REST human from an `/mcp` session client.

## Decision

`stdio` is allowed only in an admin's tenant, and only when a human who is an admin of that
tenant configured it through a REST session; an agent never qualifies. Proposals
are model-authored and `/mcp` clients are AI clients, so both count as agents. Everyone else
uses remote MCP over `https`.

- **Writer provenance.** `AuthenticatedActor.restSession` is set only by the REST adapter's
  `restActor`; the MCP and AgentTool composition roots never set it and no input schema
  accepts it. The application service passes `humanWriterUserId` to the choke point only for
  a `restSession` actor with no `agentProjectItemId`. It travels as an option of
  `createItemWithClient`/`updateItemWithClient` into `ItemCreateHookContext` and
  `ItemUpdateHookContext`; every internal caller leaves it unset. This extends the hook
  contexts of the two hook decisions above; it replaces neither.
- **Policy.** `tenantAllowsStdio` is true when the user is an admin of the current tenant.
  The MCP server hooks refuse a `stdio` config without a `humanWriterUserId` passing it, with
  one message that does not say whether the writer was an agent, an `/mcp` client or a
  non-admin.
- **Proposals.** Proposal validation rejects `transport: "stdio"` outright, so a model-authored
  host command never becomes a card, and a stored envelope is refused again at confirm.

## Consequences

- The check runs inside the write's transaction, so a refusal rolls the write back atomically.
  It takes no lock on the admin's `users` row and runs at READ COMMITTED, so a demotion that
  commits while the write is in flight does not stop that write; the spawn-time re-check of
  #1033 is the backstop for such a config.
- Re-checking at spawn is the job of #1033, and sandboxing the child under a dedicated uid
  that of #1070; this decision only governs what may be stored.
- A fixture that stores a `stdio` config through the choke point needs a REST writer who is an
  admin of the sole tenant, or must pass such an admin as `humanWriterUserId`.
