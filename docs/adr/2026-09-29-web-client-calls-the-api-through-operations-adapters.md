---
status: accepted
date: 2026-09-29
area: [web]
supersedes: [2026-09-14-authenticated-api-boundary-in-web-client]
superseded-by: null
---

# Web client calls the API through operations adapters

## Context

`AuthenticatedApiClient` and `AuthenticatedWebContext`
(`2026-09-14-authenticated-api-boundary-in-web-client`) were never mounted:
`main.tsx` and `App.tsx` never import them, `AuthenticatedWebProvider` is
required for `useAuthenticatedWebContext` to work at all, and the client
duplicated the `View`/`Item` zod schemas already defined in
`genericOperations.ts`, plus a second `ViewRendererProps` shape
(`{ viewId, databaseId }`) that never matched the live `{ view, operations }`
props renderers actually receive. The stack that is mounted already solved
the same problem differently: `GenericOperations` (`genericOperations.ts`)
with its HTTP binding (`httpGenericOperations.ts`) handles every item/view
read and write, and bespoke route families each have their own
`create*Operations({ baseUrl, fetchImpl })` factory
(`aiUsageOperations.ts`, `systemHealthOperations.ts`,
`mcpAgentPageOperations.ts`, `approvalQueueOperations.ts`,
`agentRunOperations.ts`, `setupOperations.ts`, `authOperations.ts`).

## Decision

The web client talks to the backend through operations adapters under
`web/src/api/`: the generic `GenericOperations` port for every item/view
read and write, plus one `create*Operations({ baseUrl, fetchImpl })` factory
per bespoke route family. Each adapter zod-parses its response at the edge,
sends `credentials: "same-origin"`, and maps HTTP statuses onto
`OperationError`'s `unavailable`/`retryable` outcomes. Renderers receive
operations as props (`ViewRendererProps { view, operations }`); they never
call `fetch` directly.

## Consequences

- One place per route family absorbs a shape change, instead of the change
  being reproduced in every caller.
- A new screen adds an adapter or extends `GenericOperations`, not an inline
  `fetch` call.
- There is exactly one API-boundary pattern in the web client; a second one
  cannot silently drift unmounted the way `AuthenticatedApiClient` did.
