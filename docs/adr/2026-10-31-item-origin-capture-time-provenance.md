---
status: accepted
date: 2026-10-31
area: [backend]
supersedes: []
superseded-by: null
---

# Record the provenance of an item origin's capture time

## Context

An Inbox source can supply a capture date and time. Items do not retain an immutable
creation time, so an updated proposal timestamp cannot establish when a transcript
card was created. Existing origin timestamps may have used that estimate.

## Decision

An origin has a nullable `captured_at` and a `capture_time_basis`. New confirmations
write `inboxCapture` with the source Inbox capture instant when it resolves, or
`unknown` with a null timestamp otherwise. Historical rows and writes from older
code use the default `legacyUnverified`; their timestamps remain unchanged and are
not represented as verified capture times.

## Consequences

Readers must inspect the basis before treating a timestamp as a capture instant.
The additive migration retains old values and permits older writers to continue.
