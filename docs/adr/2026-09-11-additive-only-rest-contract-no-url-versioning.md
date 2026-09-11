---
status: accepted
date: 2026-09-11
area: [backend]
supersedes: []
superseded-by: null
---

# The generic REST contract has no URL versioning; changes are additive only

## Context

Issue #238 establishes the `semprec-api` REST adapter that every generic
resource route (#155-158, mounted by #239) will share: authentication, request
validation, the item envelope, and the closed error-code contract. Native iOS
clients and the web client both talk to this contract directly, and unlike an
internal library, its callers cannot all be redeployed at once — an old iOS
build stays on a device until the user updates it.

The usual alternative for a contract that must change over time is URL
versioning (`/api/v1/...`, `/api/v2/...`): each breaking change becomes a new
version, and old clients keep hitting the old path until they're retired. That
approach was considered and rejected here.

## Decision

The adapter's contract carries no version segment in its routes. Instead, every
change to the item envelope, the error contract, or a route's request/response
shape must be additive:

- A new field may be added to the item envelope or an error's `details`; an
  existing field is never removed or repurposed.
- A new value may be added to the closed error-code enum; an existing code's
  meaning or HTTP status never changes.
- A new route may be added; an existing route's request or response shape
  never changes in a way an already-deployed client can't tolerate.

A genuinely breaking change (removing a field, changing what a code means) is
not supported by this contract — it requires a new route or field name, not a
new version prefix.

## Consequences

- Clients can add tolerance for unknown fields/codes once and never need to
  renegotiate a version with the server.
- The server never has to run two parallel contract versions side by side.
- This constrains the adapter's own evolution: a route handler cannot repurpose
  an existing field or error code even when it seems locally convenient — a
  new name is required instead.
- Enforced by `services/semprec-api/src/adapter/adapterRoute.ts`'s doc comment
  at the code level; this ADR is the recorded decision behind that comment.
