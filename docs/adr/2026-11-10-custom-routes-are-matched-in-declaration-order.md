---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Custom routes are matched in declaration order

## Context

A module declares its custom routes in its manifest
([[2026-09-11-module-manifest-custom-routes]]). `semprec-api` mounts them
through `mountRoutes` (`backend/services/semprec-api/src/adapter/routeTable.ts`),
which turns every path into an anchored pattern in which a `:name` segment
matches any one segment, and answers a request with the first route of its
list whose method and pattern match. The list is what
`ModuleRegistry.getCustomRouteDefinitions()` returns: the active modules in the
order they were loaded, and each module's routes in the order of its
`customRoutes`.

The registry refuses two routes with the same method and the same path text.
It compares text, not what the paths match. gh-1747 prescribes
`GET /api/mail/threads/facets`, and the mail module already declares
`GET /api/mail/threads/:threadId`. The two texts differ, so the registry
accepts both, and both patterns match the request
`GET /api/mail/threads/facets`. It is the first custom route that another
custom route of the same method also matches. Which of the two answers was
decided only by how `mountRoutes` happens to search its list, and nothing
recorded that a manifest may rely on it.

Two alternatives were considered. The route table could rank routes, a literal
segment before a parameter. That changes how every mounted table is searched,
the generic resource routes included, for one route. The registry could refuse
overlapping paths. That forbids the path the issue prescribes.

## Decision

- **Declaration order decides.** A request is answered by the first custom
  route, in the order above, whose method and pattern match it. The route
  table does not rank routes by how specific they are, and the registry does
  not look for overlap.
- **The narrower route is declared first.** When a module declares a route
  whose path another route of the same method in the same manifest also
  matches, it declares the narrower one before the wider one. In the mail
  manifest `mailThreadFacets` stands before `mailThreadDetail`, with a comment
  that says why.
- **Two modules are not covered.** The order of two modules' routes is the
  order in which the modules were loaded, which no manifest controls. Two
  modules whose routes overlap need a decision of their own.

## Consequences

- A route declared after a wider route of the same method is never reached.
  If `mailThreadFacets` stood after `mailThreadDetail`, the detail handler
  would answer the facets path with a 400 for a `threadId` that is not a UUID.
  The case `mail thread facets` of `tenantIsolationRoutes.test.ts` requests
  the path through the dispatcher and reads the facets body, so that order
  fails there.
- A parameter value equal to the literal segment no longer reaches the wider
  route: `GET /api/mail/threads/facets` is never a thread detail. A thread id
  is a UUID, so no thread is lost. A module that puts a literal segment next
  to a parameter that holds free text checks which values it takes away.
- The end of `customRoutes` is not always the place of a new route. A new
  route goes before every declared route of its method that also matches its
  path.
