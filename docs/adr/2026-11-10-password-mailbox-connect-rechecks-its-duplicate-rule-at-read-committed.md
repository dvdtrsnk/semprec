---
status: accepted
date: 2026-11-10
area: [backend]
supersedes: []
superseded-by: null
---

# Password mailbox connect re-checks its duplicate rule at READ COMMITTED without a row lock

## Context

Gh-1736 adds `POST /api/mail/mailboxes`
(`createMailboxPasswordConnectRouteHandler` in
`backend/packages/data/src/mail/mailboxPasswordRouteHandlers.ts`). It connects
an iCloud or a generic IMAP mailbox with a password. Between reading the
request and writing the mailbox it verifies the login against the mail server
(`verifyMailCredentials`), which can take up to 15 seconds for every endpoint it
tries.

The issue decides a duplicate rule: an address that a mailbox of the tenant
already holds answers 409 and creates nothing. An address is held when a sync
state row records it as `provider_account_address`, or when the `addresses`
list of a Mailboxes item names it. The rule is read before the verification and
again in the transaction that writes.

The issue names
[[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
for the verification. The route keeps that decision's shape: a read, the
external call outside any transaction, and a write transaction that reads again
and writes nothing when the answer changed. Two details need their own
decision.

That decision runs both transactions at `repeatable read`, so that the reads of
one transaction see one snapshot. Here that level has no use and does harm:

- The first read decides only an early refusal. No value it reads is carried
  into the write, because the write transaction reads the whole rule again.
  Each half of the rule is one statement and either half alone refuses, so the
  two statements need no common snapshot.
- The second read exists to see what committed while the login was verified.
  READ COMMITTED gives every statement a snapshot of its own start.
- The write transaction calls `storeCredential`. It creates the tenant's data
  key on first use with `INSERT … ON CONFLICT DO NOTHING` and reads the row
  back (`getOrCreateTenantDataKey`). Under READ COMMITTED a second creator waits
  for the first one, inserts nothing and reads the committed key. Under
  REPEATABLE READ PostgreSQL fails that insert with a serialization failure
  (SQLSTATE 40001) when the conflicting row committed after the transaction's
  snapshot. The loser of two first connects in a tenant would then get an
  unexpected error where the issue asks for a 409.

The `state-writes` skill asks for a row lock on what a guard reads, unless a
decision for that path says otherwise. Here the guard looks for a row that must
not exist. A mailbox that another transaction is still inserting is invisible
at every isolation level and cannot be locked. `SELECT … FOR SHARE` over the
tenant's Mailboxes items would only hold still the lists that already exist,
and it would make every connect wait for any transaction that holds a row lock
on any of those items.

The body of the accepted bracket decision stays as it is. This record narrows it
for this one route.

## Decision

The connect route opens its two transactions with `withTransaction` and no
isolation option, which is READ COMMITTED.

1. **Read the rule and commit.** `mailboxHoldsAddress` reads each half with one
   statement. The first looks for the normalized address in
   `mail_account_sync_state.provider_account_address`. When it finds no row,
   the second reads the `addresses` property of every Mailboxes item of the
   tenant, splits it with `parseAddressListProperty` and compares each entry
   after `normalizeEmailAddress`. A held address answers 409
   `provider_account_already_connected` before any mail server is contacted.
   The transaction writes nothing.
2. **Verify the login outside any transaction.** A failure creates nothing,
   because nothing has been written.
3. **Read the rule again and write, in one transaction.** `createPasswordMailbox`
   calls `mailboxHoldsAddress` before its first write. A held address throws
   `ProviderAccountAlreadyConnectedError`, and the transaction rolls back
   without having written. Otherwise it writes the Mailboxes item, its address,
   the sealed password, the server settings, the sync state row with
   `provider_account_address` and the first sync job.
4. **The reads take no row lock.** What they protect is stated in 5 and 6.
5. **The address index decides between concurrent connects.** The partial
   unique index `mail_account_sync_state_tenant_provider_address_uq` on
   `(tenant_id, provider_account_address)` holds at every isolation level. A
   second transaction that records the same address waits in
   `recordProviderAccountAddress` until the first one commits or rolls back,
   and then fails with a unique violation or proceeds. The store maps the
   violation to `ProviderAccountAlreadyConnectedError`. Postgres has aborted
   the transaction by then, so it rolls back whole: no item, credential, server
   settings, sync state row or job of the refused mailbox remains.
6. **The address-list half is read again, not serialized.** A transaction that
   commits a list naming the address after this transaction's read and before
   its commit is not seen. This route writes one address per mailbox and
   records the same address in the indexed column, so two password connects can
   collide only there, where 5 decides. The half can miss only a concurrent
   writer of another flow that puts the address into an alias list.
7. **One refusal for both halves.** Both raise
   `ProviderAccountAlreadyConnectedError` (409
   `provider_account_already_connected`). A trashed Mailboxes item counts in
   both halves: its sync state row keeps the recorded address, and the index
   counts that row too.

## Consequences

- No transaction is open while the mail server is contacted.
- An address that is already held when the request arrives is refused without
  sending the password to any server. A wrong password for such an address
  therefore answers 409 and not the verification's code.
- Two identical requests at the same time create one mailbox, and the other one
  is answered 409, whether its own second read or the index refused it.
- Two first connects in a tenant without a data key share one key.
- A login that was verified is dropped when the write is refused: the password
  is stored nowhere.
- The address-list half has a window as long as the write transaction. A flow
  that needs it exact against concurrent writers has to add a lock that every
  writer of `Mailboxes.addresses` takes, and record that decision. This record
  authorizes no lock.
- A later route that reads tenant state before a provider call and decides its
  write from the value it read is not covered. It follows
  [[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
  or records its own decision.
