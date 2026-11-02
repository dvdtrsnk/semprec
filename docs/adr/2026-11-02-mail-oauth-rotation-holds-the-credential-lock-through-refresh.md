---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# Mail OAuth rotation holds the credential lock through refresh

## Context

Gh-1481 requires a rotating refresh token to be replaced durably before the
new access token is returned. Two callers reading the same token before either
exchange can consume one provider generation twice. A provider may retire that
generation immediately, and a database rollback cannot undo that external action.

The normal read/call/revalidate pattern in
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
cannot safely replay this exchange after detecting staleness. A process-local
mutex does not coordinate other processes. A session lock outside a transaction
would introduce different connection ownership and still needs coordination
with credential updates. Persisting access tokens or a distributed refresh
lease would add storage and recovery contracts beyond this issue.

## Decision

For `refreshAndPersistAccessToken` only, permit the OAuth refresh HTTP request
inside one explicitly tenant-scoped READ COMMITTED `withTransaction`. Acquire
the existing mailbox credential row FOR UPDATE before decryption and retain
the lock through exchange, optional replacement via the credential store and
commit. Do not pre-read a refresh token outside the lock. Missing or foreign
credentials fail without a provider request. This is a narrow exception to the
external-call bracketing ADR and the corresponding default state-write rule;
all other external calls retain their existing decisions. Transaction opening,
rollback and release still belong to
[[2026-09-29-withtransaction-is-the-sole-transaction-opener]].

Bound the refresh request, including its response body, by 15 seconds and cap
that body at 64 KiB. Cancellation must abort the owned request and release its
body resources. Inside the refresh transaction cap lock waits at 30 seconds
and statements at 60 seconds, retaining an already stricter nonzero setting;
transaction-local settings must not leak to the next pool user. Retain the
pool's configured checkout bound. These are per-request/per-wait limits, not
a promise of one total end-to-end deadline or immediate database cancellation.
Do not automatically replay the transaction or token exchange on a timeout,
connection loss, persistence failure or ambiguous commit.

A waiter reads the newly committed refresh credential and makes its own
exchange; it does not receive a shared cached access token. For two successful
rotating exchanges with committed replacements, each refresh generation is
presented once. Providers returning no replacement leave the stored credential
unchanged and may legitimately receive it again. Access tokens remain transient;
this decision adds no global cache, plaintext persistence or schema.

Return the access token only after commit succeeds. Provider rejection keeps
the existing 400/401 reauthorization classification. A persistence or commit
failure returns no access token and must remain observable without exposing
tokens, client secrets, provider bodies or raw credential-bearing exceptions in
logs. An acknowledged rollback leaves the prior database credential; the
provider may already have invalidated it. Lost commit acknowledgement leaves
the database outcome uncertain. Neither case promises recovery or exactly-once
provider effects; a later sync may require reauthorization. Do not recategorize
unknown database/transport failures as authentication rejection.

## Consequences

One connection and the mailbox credential lock stay occupied across bounded
provider latency. Other operations on that credential can wait or time out.
Distinct mailbox credentials and tenants must not be serialized by a new global
lock. Existing credential/key ownership and other callers' lock order remain
unchanged; no global deadlock-freedom claim follows from this decision.

Runtime-role tests will force actual same-mailbox overlap using operation-owned
PIDs and the exact blocker, prove committed generation ordering and independent
mailbox/tenant progress, and exercise provider rejection, deadline/body bounds,
failed persistence, rollback/release and no access-token return before commit.
Secret sentinels must be absent from inspected outward errors and actual
serialized application logs. Fake local providers establish these finite
scenarios; live provider behavior and production recovery remain unverified.
