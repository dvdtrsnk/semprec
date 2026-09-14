---
status: accepted
date: 2026-09-14
area: [web]
supersedes: []
superseded-by: null
---

# Web view types register one renderer at module load

## Context

Views store a kebab-case type, while the web client needs the component that
can render that type. Allowing a generic route to choose a component itself,
or allowing several components to claim the same type, makes the stored type
ambiguous and couples the route to every feature renderer.

The alternative is a route-level switch or feature-specific routing. Both
would need editing whenever a view type is introduced and permit competing
renderers for the same stored type.

## Decision

The web client has one `ViewTypeRegistry`. A view-type module registers its
renderer once during module loading under its kebab-case stored type, and the
generic view route dispatches only through that registry. Registration rejects
a duplicate type, so a registered type has exactly one renderer. Every
renderer receives the generic `{ viewId, databaseId }` props.

## Consequences

- The generic route stays independent of feature renderers and only resolves
  URL parameters plus a registered type.
- Adding a view type is a registration change in the owning feature, not a
  new route branch.
- A duplicate registration fails during application initialization rather
  than silently selecting one renderer at runtime.
