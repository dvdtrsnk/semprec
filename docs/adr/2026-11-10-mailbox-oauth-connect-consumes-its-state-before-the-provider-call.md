---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Mailbox OAuth connect consumes its one-time state before the provider call

## Context

Gh-1686 adds `POST /api/mail/mailboxes/oauth/complete`
(`createMailOauthCompleteRouteHandler` in
`backend/packages/data/src/mail/mailOauthRouteHandlers.ts`). It turns a one-time
sign-in state (table `mail_oauth_states`, gh-1483) and the provider's
authorization code into a connected mailbox. Between reading the state and
writing the mailbox it calls the provider: the code exchange, then the lookups
of the account's own address and aliases.

The issue names
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
for that call. The route keeps that decision's rule that no transaction is open
across the external call, and departs from the rest of its shape. That decision
brackets the call with a `repeatable read` transaction that only reads a
snapshot and a `repeatable read` transaction that re-validates the snapshot
before it writes. It fits a result computed from data that can change during
the call. Here the input is a secret that may be used once. The issue decides
that the state is consumed before the exchange, so a provider failure requires
a new start. A transaction that only read the state would leave it valid while
the provider is called, and a second request could exchange a code with the
same verifier. Nothing else the route reads before the call decides what it
writes afterwards.

The same route is the first code outside the Gmail watch lifecycle that writes
`mail_account_sync_state.gmail_watch_email_address`. That column is the key the
router function `route_gmail_address` matches a Pub/Sub notification against
([[2026-10-07-cross-tenant-router-functions]]), and migration 0071 introduced it
as written by the watch lifecycle alone.
[[2026-09-10-single-writer-ownership-model]] asks for a recorded handoff before
a second process writes a field. The column belongs to a side table of the mail
module and has no entry in a module contract, so the handoff is written down
here.

The bodies of those accepted decisions stay as they are. This record narrows
the bracket decision for this one route and records the handoff the ownership
decision asks for.

## Decision

The complete route runs the steps below. Every transaction is opened by
`withTransaction` without an isolation option, which is READ COMMITTED.

1. **Consume the state and commit.** One transaction runs
   `consumeMailOauthState`: a single
   `UPDATE mail_oauth_states SET used_at = now()`, guarded by the state hash,
   the calling user, `used_at IS NULL` and `expires_at > now()`, which returns
   the row; the PKCE verifier is then unsealed. The transaction commits before
   the first provider request.

   The consumption is not undone afterwards. A refusal or an outage of the
   provider, a missing OAuth client, a reauthorization state (which this route
   refuses until gh-1742), an address that is already connected and a failed
   write all leave the state used, and the user starts a new sign-in. Only a
   failure inside this transaction, such as a verifier that cannot be unsealed,
   rolls the consumption back with it.

   READ COMMITTED is what gives the loser of a race the right answer. A second
   request that presents the same state waits for the first transaction's row
   lock, re-evaluates the guard against the committed row and updates no row,
   which the route answers with the same 400 `validation_failed` as an unknown
   state. Under REPEATABLE READ that waiter would fail with a serialization
   failure (SQLSTATE 40001), and the route would need a retry loop to turn it
   into that answer.

2. **Call the provider outside any transaction.** A failure creates nothing,
   because only the consumption has been written.

3. **Write the mailbox in one transaction, without re-validating.**
   `createConnectedMailbox` writes the Mailboxes item, its addresses, the sealed
   refresh token, the sync state row with `provider_account_address` and the
   first sync job. Its inputs are the provider named by the consumed state, the
   session's user and the provider's answers. None of them is tenant data read
   before the call, so there is no snapshot to compare.

   The one fact another request can change meanwhile is whether a mailbox of
   the tenant already records the address. The route does not read it
   beforehand. The partial unique index
   `mail_account_sync_state_tenant_provider_address_uq` on
   `(tenant_id, provider_account_address)` decides it when
   `recordProviderAccountAddress` runs: a concurrent writer of the same address
   waits until the first one commits or rolls back, and then fails with a
   unique violation or proceeds. The index holds at every isolation level, so
   the transaction runs at READ COMMITTED like any other item create. The
   violation aborts the transaction, which rolls back whole: no item,
   credential, sync state row or job of the refused mailbox remains.

4. **Name the existing mailbox after the rollback.** Postgres accepts no
   further statement in the aborted transaction, so the route reads the mailbox
   that records the address in a further transaction
   (`findMailboxByProviderAccountAddress`) and answers 409
   `provider_account_already_connected` with `details.mailboxId`. That read is
   not atomic with the refusal. When no mailbox records the address any more by
   then, `mailboxId` is `null`; the answer is 409 in both cases.

5. **The connect flow writes `gmail_watch_email_address` once, at creation.**
   For a `gmail` mailbox, step 3 stores through `recordGmailWatchEmailAddress`
   the address that `users.getProfile` reported for the account whose refresh
   token it seals in the same transaction. It is the same normalized value the
   step stores as `provider_account_address`. `route_gmail_address` reads past
   row-level security and routes notifications to every mailbox that carries
   the address, so the value never comes from the request body or from the
   alias list in `Mailboxes.addresses`: an alias can be an address of another
   account. The Gmail watch lifecycle stays the column's owner from then on.
   `recordGmailWatchRegistration` replaces the value on every registration with
   the address `providerVerifiedAddressOf` reads from
   `provider_account_address`. This record authorizes no further writer.

## Consequences

- No transaction is open during a provider request.
- A state admits one exchange. Two requests that present the same state cannot
  both reach the provider.
- A sign-in that fails after step 1 cannot be repeated with the same state,
  even when the failure was the provider's or this server's. The user starts
  again and consents once more.
- A refresh token obtained in step 2 is dropped when the address is already
  connected or step 3 fails. The route does not revoke it: the grant stays in
  place at the provider, and this server holds no token for it.
- Two sign-ins that write the same address at the same time create one mailbox;
  the other one is answered 409.
- A Gmail mailbox is routable by its account address from its first commit, not
  from its first watch registration.
- The reauthorization branch (gh-1742) will run in this route and inherits
  steps 1 and 2. This record does not cover a branch that reads tenant state
  before the provider call and decides its write from it, such as the address
  an existing mailbox records. Such a branch re-validates that state in its
  write transaction as
  [[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
  requires, or records its own decision.
- The header of migration 0071 predates this handoff and still names the watch
  lifecycle as the only writer of `gmail_watch_email_address`. The store's doc
  comments name both writers.
