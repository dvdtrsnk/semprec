---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Bound the existing IDs supplied to Inbox proposal computation

## Context

Gh-1488 and gh-1492 require proposed existing IDs to come from the request.
Their original context assumes gh-1987's workspace reader, which is scheduled
later and depends on a grant mechanism not yet implemented. An empty context
would prevent useful relations; reading arbitrary tenant databases would expose
more data than these Tasks require.

This is a narrow foundation for those two Tasks, under
[[2026-10-31-owner-delegated-backend-program-supervision]]. It preserves
[[2026-09-10-ai-gateway-monopoly-on-provider-calls]] and
[[2026-10-03-tenant-isolation-through-row-level-security]].

## Decision

A read-only data helper directly resolves the five built-in module databases
Projects, Areas, People, Companies and Events under an explicit tenant scope.
It does not enumerate arbitrary database records through the writable-target
catalog. Databases must be built-in and unarchived; rows must be live. Projects
are limited to `inProgress` and `longTerm`; Events to capture date minus one
through plus fourteen calendar days. Invalid capture dates contribute no Events.

Each kind contributes at most twenty entries, with only checked item ID and
name, the name capped at one hundred characters. Order is most recent update
then ID, or soonest date then ID for Events. The typed context retains database
identity for membership checking. No custom database, Health, mail, body or
computed content is included. This allowlist is a limited disclosure decision,
not an implementation of future project grants or permission to bypass them.

The API assembler reads this context, plain-property and writable-target
catalogs, and user-owned relation definitions in one short tenant transaction.
The gateway call happens after release. Existing writable-target schema
discovery is not authority to disclose the records of those other databases.

Existing relation IDs must appear in the request for the relation's exact
target database. Unknown/system keys and wrong-target, foreign or invented
IDs are removed; duplicate IDs are removed and cardinality is capped at one or
ten. Only checked canonical keys or a fixed marker and count may enter logs.
An update/link operation's existing item ID must have matching-database request
membership; a violation takes the tick's `needsClarification` path, without a
target write. Local aliases resolve only through eligible create steps and
the existing graph/envelope checks. Current locked before-state and transform
validation remains in force.

## Alternatives rejected

- Read all tenant records behind the writable catalog. Tenant isolation alone
  does not justify sending unrelated or sensitive content to a model.
- Accept any same-tenant ID returned by the model. It was not necessarily
  disclosed in this request or valid for the relation's target database.
- Implement all of gh-1987 early. That also owns grant-aware reads, capture
  facts, recompute state and a request-size policy with later prerequisites.

## Consequences

Some valid existing records are outside the bounded request and cannot be used
by this computation. The computation writes nothing; the real tick validates
and stores the resulting proposal or clarification. Gh-1987 must reuse or
replace this foundation with its grant-aware path before expanding disclosure,
including any future sensitive marking of a built-in database. It remains open;
this decision does not claim its capture, grant or recompute AC are complete.
