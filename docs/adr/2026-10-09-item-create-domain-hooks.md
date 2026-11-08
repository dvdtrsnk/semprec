---
status: accepted
date: 2026-10-09
area: [backend]
supersedes: []
superseded-by: null
---

# A domain validates or reacts to an item insert through a create-hook registry

## Context

[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] gave the
choke point per-process registries so a domain's transactional side effect
reaches `updateItemWithClient` and the relation-edge writes without
`chokePoint/` importing the domain. There was no registry for the insert:
`createItemWithClient` ran no hook, so a domain that must validate what an
item is *created* with had no place to do it, and `chokePoint/` may not import
`mcp/` directly (`chokepoint-knows-no-domain`).

`mcpServers.connectionConfig` hit this. Its `sse`/`http` variants carry a URL
the server later fetches, and
[[2026-09-27-ssrf-protection-for-stored-outbound-urls]] requires every stored
outbound URL to pass a baseline check when stored. Only the proposal path
checked the config; REST, `/mcp` and the AgentTools stored any JSON.

## Decision

`chokePoint/hooks.ts` gains a third registry, `registerItemCreateHook` /
`runItemCreateHooks`, with the same `Set` semantics as the update registry
(registering a function twice is a no-op; hooks run sequentially in
registration order; `clearHooksForTests` clears it). A hook receives
`{ client, database, item, properties }`.

`createItemWithClient` runs the create hooks after a real insert, inside the
write's transaction and before the `onItemEvent` heartbeat trigger. It never
runs them on an idempotency-key replay: the replayed row was already hooked
when it was first created. A rejection rolls the insert back.

MCP remote URLs now follow the stored-outbound-URL ADR through
`isBaselineOutboundUrl` (`net/storedOutboundUrl.ts`), the rule previously
private to `validateWebPushEndpoint`. `mcpServerItemCreateHook` and
`mcpServerItemUpdateHook` apply it to `connectionConfig` on every write to the
`mcpServers` database that touches that property.

## Consequences

- Every write path that ends in `createItemWithClient` or
  `updateItemWithClient` is covered by one check, including the proposal
  confirm path.
- Fixtures that write a non-baseline remote URL through the choke point must
  use an `https` DNS URL or insert the row directly.
- Connect-time checks of the resolved address remain a separate concern.
