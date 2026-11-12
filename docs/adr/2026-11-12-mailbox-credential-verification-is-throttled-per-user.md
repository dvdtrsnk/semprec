---
status: accepted
date: 2026-11-12
area: [backend]
supersedes: []
superseded-by: null
---

# The mailbox login verification is throttled per user, in process memory

## Context

Gh-1736 added `POST /api/mail/mailboxes`
(`createMailboxPasswordConnectRouteHandler` in
`backend/packages/data/src/mail/mailboxPasswordRouteHandlers.ts`). It opens
connections to mail servers the caller names and tries a password there
(`verifyMailCredentials`). Without a limit a signed-in user could use this
server to test passwords against third-party mail servers. Gh-1750 decides the
limit: at most 10 attempts per 15 minutes per user. Every attempt that reaches
the network check counts, whether the login is accepted or not, and a request
with an invalid body does not count.

[[2026-10-17-per-ip-auth-throttles-held-in-process]] introduced the limiter
(`createClientIpThrottle` in
`backend/services/semprec-api/src/clientIpThrottle.ts`). That decision covers
the public authentication routes. It keys every window by client address, and
its routes are bespoke listeners that write their 429 themselves. The password
connect route differs on each point:

- It needs a session, and the party to limit is the account, not the address
  the account calls from.
- It is a module custom route. Its handler lives in `packages/data`, cannot
  import the limiter of `semprec-api`, and answers through the REST adapter,
  which had no way to send a response header with an error.
- Between the body validation and the verification it reads the duplicate rule
  once ([[2026-11-10-password-mailbox-connect-rechecks-its-duplicate-rule-at-read-committed]])
  and answers a held address with 409 before any mail server is contacted. The
  issue places the count "after body validation and before calling the
  verification", which leaves open on which side of that read it goes.

The bodies of those decisions stay as they are. This record extends the limiter
by one action and records what that extension adds.

## Decision

1. **One more action, keyed by user id.** The limiter gains the action
   `mailboxCredentialVerification`: 10 events per 900 seconds. Its key is the
   session's user id exactly as given. The address grouping
   (`throttleKeyForIp`) applies to the four public actions and not to this one.
   The client address is not part of the key, so an account has one budget from
   every address, and two accounts behind one address do not share a budget.
2. **State stays in process memory**, under the single-process assumption of
   [[2026-10-17-per-ip-auth-throttles-held-in-process]]: a restart clears every
   window, and a second semprec-api process would give each its own budget.
3. **The dispatcher creates the instance.** `createDispatcher`
   (`backend/services/semprec-api/src/app.ts`) creates one limiter for its
   lifetime and hands it to the custom routes as the member `throttle` of the
   container of [[2026-10-29-custom-route-composition-root-dependencies]]. A
   container that already carries a `throttle` keeps it, which is how a test
   supplies a clock. This instance is not the one the auth listener or the
   invitation listener creates for itself, so keys of the public routes cannot
   evict a user's window.
4. **Without a limiter the route verifies nothing.** The handler reads the
   member once per request, as it reads its verification. A mount without it
   fails the request with a plain error, which the adapter answers as a generic
   500, before any mail server is contacted. The route has no limiter of its
   own to fall back on.
5. **The attempt is counted directly before the verification.** The handler
   validates the body, reads its two container members, resolves the default
   name of the mailbox, reads the duplicate rule, calls `tryAcquire` and then
   calls the verification, with no `await` between the last two. `tryAcquire`
   checks the limit and counts the attempt in one synchronous step, so of a
   concurrent burst of one user at most 10 requests call the verification, and
   the attempts still in flight hold their place in the window. A request that
   was refused for its body (400) or for an address the tenant already holds
   (409), or that failed before that point, is not counted.
6. **A counted attempt stays counted.** The route never releases the
   reservation `tryAcquire` returns. An accepted login, a refused login, an
   unreachable server, an unexpected failure of the verification and a write
   that failed or was refused afterwards all stay in the window, because the
   verification was called for each of them.
7. **The refusal is `RateLimitedError`.** A user at the limit is answered 429
   with the body `{ "error": { "code": "rate_limited" } }` and a `Retry-After`
   header that holds the whole seconds until the oldest counted attempt leaves
   the window. `RateLimitedError` (`backend/packages/data/src/errors.ts`)
   carries those seconds, and the REST adapter
   (`backend/services/semprec-api/src/adapter/adapterRoute.ts`) writes the
   header for that error class. The seconds are not in the body. The status and
   the code are the ones the public auth listeners answer; their own body shape
   is unchanged.

## Alternatives considered

- **Count right after the body validation, before the duplicate rule is
  read.** Rejected: a request that the rule answers with 409 contacts no mail
  server, so counting it would use up a user's attempts on requests that tested
  no password.
- **Count before the validation and release on a validation failure**, as the
  public routes do before they read their body. Rejected: the adapter has read
  and parsed the body before the handler runs and the validation is
  synchronous, so nothing is gained for a concurrent burst. It shares the
  drawback of the first alternative, and it answers an invalid body at the
  limit with 429 instead of 400.
- **Key by client address.** Rejected: one account would get a fresh budget
  from every address it can call from, and accounts behind one address would
  share one.
- **State outside the process.** Gh-1750 leaves a database-backed or
  multi-process limiter out of its scope. The trade-off is the one
  [[2026-10-17-per-ip-auth-throttles-held-in-process]] records.

## Consequences

- A user can have at most 10 logins verified per 15 minutes. Accepted logins
  count, so a user can also connect at most 10 password mailboxes in that time.
  One verification can try more than one endpoint: `verifyMailCredentials`
  tries up to two per protocol for a generic mailbox.
- A user at the limit waits until the oldest counted attempt is 15 minutes old.
  The `Retry-After` header names that wait.
- The limit is on verifications, not on requests. An invalid body is answered
  400 and a held address 409 at the limit too, and the read of the duplicate
  rule runs for every request with a valid body.
- The keys are ids of signed-in users. Filling the map to evict a throttled
  key, the weakness [[2026-10-17-per-ip-auth-throttles-held-in-process]] names
  for addresses, needs `maxKeys` (50,000) accounts that each had a login
  verified inside the window.
- A restart of semprec-api gives every user a full budget again.
- This record covers the password connect route. The OAuth connect routes and
  every other authenticated route stay without a limit of this kind.
