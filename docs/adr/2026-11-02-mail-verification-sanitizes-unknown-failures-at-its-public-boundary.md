---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# Mail verification sanitizes unknown failures at its public boundary

## Context

Gh-1569 says unknown failures propagate. The verification privacy boundary in
[[2026-11-02-mail-credential-verification-owns-bounded-policy-connections]]
forbids exposing raw causes, addresses, server transcripts or credentials.
Arbitrary library rejection values can contain all of these, including nested
AggregateError members and non-Error values. Requiring outward identity would
make that privacy boundary impossible to uphold. Conversely, converting an
unknown error into authentication, TLS or unreachable would invent a diagnosis.

## Decision

Keep original rejection values, explicit presence (including undefined), source
and observation order inside the owned helper/orchestrator lifecycle until all
actual operations and cleanup settle and diagnostic processing completes.
Retain primary and secondary identities there; cleanup must not erase the
primary or silently discard an independently observed failure. This does not
authorize a durable error store, public introspection hook or raw error log.

At verifyMailCredentials and its test wrapper's outward privacy boundary, an
unknown helper or lifecycle failure terminates verification with a fresh fixed
generic Error. It is not one of the four known mail errors, does not fall back
to another candidate, and does not return settings. The outward error carries
no raw cause, aggregate members, original properties, server text or arbitrary
name/code. Its message and classification are independent of the supplied
rejection value. Known sanitized helper outcomes retain their existing mapping.

Use the existing logger for fixed structured diagnostic metadata: closed source
and category tags, counts and observation order only. Never serialize arbitrary
error values or traverse their properties for diagnostics. Internal exact
identity retention ends at this public boundary; callers receive failure, not
the secret-bearing original. If diagnostic emission itself fails, retain that
secondary internally and still reject outward with the fixed safe error; do not
claim the diagnostic was delivered or expose either raw failure. No recursive
logging or success fallback is introduced.

This is a narrow exception to identity-preserving propagation for credential
verification's public privacy boundary, not a general unknown-error mapper.
Default mail helpers and other APIs retain their existing contracts. The owned
cancellation decision in batch 13 section 4 still requires the actual connect
rejection to be the exact owner Error before giving a known timeout outcome.

## Consequences

Callers lose raw debugging detail intentionally, but an unknown infrastructure
or implementation failure remains a generic failure. Safe diagnostics do not
prove its underlying cause. Tests must observe real producers with forwarding
spies to establish internal primary/secondary identities and settlement, then
independently assert the fixed outward error, no candidate continuation and
secret-free serialized logs. Cover undefined, a distinct non-Error object,
secret-bearing Error/AggregateError, combined cleanup failure and diagnostic
failure. Do not add production callbacks merely to expose raw errors to tests.
