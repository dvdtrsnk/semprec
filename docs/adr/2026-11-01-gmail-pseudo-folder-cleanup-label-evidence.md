---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# Use Gmail label evidence for pseudo-folder cleanup

## Context

Gmail label identifiers are opaque. Existing folder records retain their provider identifier but
not whether Gmail classified the label as a user or system label. Cleanup therefore cannot infer
that classification from an identifier or from its absence in an inventory.

## Decision

For each Gmail mailbox, load and validate its label inventory through the existing mailbox-scoped
OAuth adapter before opening cleanup mutation transactions. Remove only folders positively
identified as non-placement system labels. Preserve user labels, unknown identifiers, the five
placement labels and the synthetic Archive folder. An unavailable or invalid inventory fails that
mailbox before its cleanup mutations and remains an error for retry.

Cleanup uses bounded keyset pages and one transaction per page as in
[[2026-09-28-chunked-transactions-for-large-background-sweeps]]. Affected messages without a
placement folder receive Archive even if a user-label edge remains. The existing OAuth refresh and
token-lock contract is unchanged.

## Consequences

An obsolete folder absent from the provider inventory is preserved because its former type cannot
be established. A provider failure delays cleanup instead of authorizing a guessed deletion.
