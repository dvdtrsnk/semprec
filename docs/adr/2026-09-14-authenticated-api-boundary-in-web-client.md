---
status: accepted
date: 2026-09-14
area: [web]
supersedes: []
superseded-by: null
---

# Authenticated web API calls use one boundary

## Context

The first web implementation needs to read views and properties, query a
view, and create an item through authenticated REST routes. Letting each
renderer build its own `fetch` request would duplicate session-cookie
handling, URL encoding, response validation, and the distinction between an
unauthenticated response and a stable query error code.

The alternative is for every future screen to call `fetch` directly. That
would leave the REST contract distributed across renderers and make a
session-handling or validation change easy to apply inconsistently.

## Decision

New authenticated web API calls use `AuthenticatedApiClient`; renderer
components receive the client through `AuthenticatedWebContext` rather than
calling `fetch` directly. The boundary always sends the session cookie,
validates successful API responses at the client boundary, preserves 401 as
an authentication outcome, and exposes API query failures as their stable
`{ code }` domain value.

Existing operation adapters are outside this bootstrap issue and migrate only
in the issue that changes their owning screen.

## Consequences

- A new renderer has one authenticated API surface to depend on, instead of a
  private HTTP implementation.
- Session and API-shape changes belong in `AuthenticatedApiClient`, with its
  boundary tests, rather than being reproduced in each caller.
- A screen needing a route not represented by the client extends this
  boundary as part of that screen's issue; it does not add an inline `fetch`.
