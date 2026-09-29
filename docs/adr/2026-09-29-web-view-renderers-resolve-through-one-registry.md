---
status: accepted
date: 2026-09-29
area: [web]
supersedes: [2026-09-14-view-type-renderers-register-once-in-web-client]
superseded-by: null
---

# Web view renderers resolve through one registry

## Context

`ViewTypeRegistry` (`view-types/registry.ts`) and the generic route it backed
(`2026-09-14-view-type-renderers-register-once-in-web-client`) were never
mounted: `main.tsx` and `App.tsx` never import `GenericViewRoute` or
`view-types/registerViews.tsx`. The stack that is mounted already has its own
registry, `web/src/views/viewRegistry.ts`, populated by
`createDefaultViewRegistry()` (`views/registerViews.ts`) and resolved by
`ViewHost`. That registry's `registerViewRenderer` was a bare `Map.set` with
no duplicate guard, unlike the decision recorded for the unmounted stack.

## Decision

`web/src/views/viewRegistry.ts` is the one `ViewRegistry` for this client.
`createDefaultViewRegistry()` registers every renderer under both the
backend's opaque `clientComponent` id and the kebab-case view type.
`registerViewRenderer` throws when called twice for the same key, so a key
resolves to exactly one renderer. `ViewHost` resolves a view by
`clientComponent` first, falling back to `type`, and renders `EmptyState` for
a view with no registered renderer. Renderers receive `{ view, operations }`.

## Consequences

- Adding a view type is a registration call in the owning feature module, not
  a new route branch or a second registry.
- A duplicate registration fails immediately, at the call site, instead of
  silently overwriting an existing renderer.
- There is exactly one view-renderer registry in the web client; a second,
  unmounted one cannot drift out of sync with it.
