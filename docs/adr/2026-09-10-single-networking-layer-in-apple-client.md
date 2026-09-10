---
status: accepted
date: 2026-09-10
area: [apple]
supersedes: []
superseded-by: null
---

# All backend calls in the Apple client go through one networking/API layer

## Context

Without a rule, individual SwiftUI views or view models can each open their
own `URLSession` request against the backend, duplicating request building,
auth, error handling, and making it hard to know from one place what the
app actually calls.

## Decision

State that talks to the backend goes through a single networking/API
layer. No view or view model opens its own `URLSession` request inline.

## Consequences

- A view or view model issuing its own `URLSession` call is a review
  finding (`apple/review-rules/rules.md`), mirroring the backend's choke-point
  discipline ([[2026-09-10-choke-point-api-for-state-writes]]) on the client
  side: one place to change auth, retries, or error handling for every
  backend call the app makes.
- New screens depend on the shared layer's shape rather than the raw REST
  API, so the layer needs to expose what screens actually need — slightly
  more upfront design than an inline request per screen.
