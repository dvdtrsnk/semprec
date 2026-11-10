---
status: accepted
date: 2026-11-05
area: [backend]
supersedes: []
superseded-by: null
---

# Automation batch reads use the domain registry

## Context

[[2026-09-30-choke-point-domain-hooks-through-a-per-process-registry]] keeps
chokePoint free of direct domain imports. Gh1768 needs one automation read for
a returned page through the injected generic application port. Its facade must
reach the existing library itemAutomationStore without importing that domain.
The synchronous per-item projection registry cannot perform this batch query.

## Decision

Add one specifically typed automation batch-reader registration to the existing
shared chokePoint/hooks.ts owner. The callback accepts the caller's PoolClient
and item IDs, and returns the existing shared automation read shape keyed by
item ID. Do not create a general asynchronous projection registry or plugin API.

Register the existing library readAutomationForItems function only in the
existing domainWriteHooks.ts composition root. Its first import from data's
index remains the process initialization contract. ChokePoint.readAutomationForItems
opens its existing transaction and invokes the registered reader with that
same client and the returned page IDs; it imports only the shared hook owner.
The library store retains the SQL, tenant predicate, validation and heartbeat
join. One nonempty page has one query, independent of page size. Empty pages
have no SQL. Reads without include=automation do not invoke this seam.

Registering the identical callback twice is a no-op; reject a different second
reader rather than silently replacing the owner. An unregistered invocation
fails with a fixed configuration error rather than claiming no automation rows.
The existing test-only clearHooksForTests resets this registration as well;
deep-import tests install composition or an explicitly isolated reader fixture.
Propagate reader failures unchanged. Export no new root helper or registration
API from the data package, and change no dependency rule or baseline.

## Consequences

The facade stays independent of the library domain and the application keeps
its existing injected typed port. Registry controls cover same-callback repeat,
conflicting owner, missing registration, test reset, argument forwarding and
unchanged rejection. Real generic/REST tests must prove the actual composed
store, tenant separation, page batching and opt-in behavior. These unit controls
do not substitute for those production-boundary assertions.
