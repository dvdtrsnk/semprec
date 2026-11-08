---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Module custom routes receive composition-root dependencies per request

## Context

[[2026-09-11-module-manifest-custom-routes]] lets a module declare a custom route whose `handlerExport` resolves to a factory. Until now the factory took only the database pool. Coming mail routes need objects that exist only in the composition root (`services/semprec-api/src/serve.ts`): the OAuth client settings read from the environment, the mail server clients that verify a password and send mail, the mail live-sync root, and an outbound `fetch`. The live-sync root is created after the request dispatcher, so it does not exist when custom routes are mounted.

A module that read the environment or built these clients itself would reach into process configuration, and its tests would have to replace globals. Building the live-sync root before the dispatcher is not possible, because the root needs the dispatcher's own pool and startup order.

## Decision

A custom route factory has the shape `(pool, dependencies) => AdapterHandler`. `dependencies` is one typed container, `CustomRouteDependencies`, defined in `services/semprec-api/src/adapter/customRouteMount.ts`. The composition root builds it and passes it through `createDispatcher` to `mountCustomRoutes`, which hands the same object to every factory. Every member is optional, and the composition root sets only the members it configured.

1. A route reads a member through `requireCustomRouteDependency`, inside its handler, once per request. The mount itself never reads a member.
2. A member the composition root did not configure fails that one request with `CustomRouteConfigurationError`, a plain error. The adapter logs it and answers a generic 500. It is not mapped to a domain error, because the deployment is missing configuration, not the caller's input.
3. A factory that needs no member keeps the `(pool)` form. TypeScript accepts it, and the adapter behaves the same.

This decision does not change the rule that a custom route's handler writes item or database state only through the choke point it wraps ([[2026-09-10-choke-point-api-for-state-writes]]).

## Consequences

- A route that reads a member while its factory runs turns one missing member into a failed mount of every custom route at startup. Review rejects that shape.
- The mail live-sync root exposes no per-mailbox control yet, only `start`, `stop`, `reconcileOnce` and `stopTenant`. The composition root therefore passes a placeholder for `mailLiveSync` whose calls refuse with `CustomRouteConfigurationError`, until the root gains per-mailbox control in a later change.
- Tests mount a route with only the members that route reads, through `createCustomRouteDependencies()` or a partial container.
- The manifest rules of [[2026-09-11-module-manifest-custom-routes]] are unchanged: one owning module per route, and one of the two justifications. That ADR's text is not edited.
