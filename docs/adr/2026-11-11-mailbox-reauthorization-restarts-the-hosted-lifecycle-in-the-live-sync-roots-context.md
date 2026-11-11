---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# Mailbox reauthorization replaces the token under row locks and restarts the hosted lifecycle in the live-sync root's own context

## Context

Gh-1742 lets a user sign in again for a Gmail or Outlook mailbox whose token was
revoked. `POST /api/mail/mailboxes/:id/reauthorize` stores a one-time state that
carries the mailbox id, and `POST /api/mail/mailboxes/oauth/complete` gains a
branch for such a state (`backend/packages/data/src/mail/mailOauthRouteHandlers.ts`).
The branch replaces the stored refresh token and then asks the mail live-sync
root (`backend/packages/data/src/mail/mailLiveSyncRoot.ts`) to restart the
mailbox's hosted lifecycle through a new `restartAccount(mailboxItemId)`. A
hosted lifecycle reads its credential once in `start()`, and a discovery pass
skips an account that is already hosted with the same sync mode, so without the
restart the old lifecycle keeps the old token.

Four accepted decisions touch this and none covers it:

- [[2026-11-10-mailbox-oauth-connect-consumes-its-state-before-the-provider-call]]
  says that the reauthorization branch inherits its steps 1 and 2 (consume the
  state and commit, call the provider outside any transaction) and leaves the
  branch's write open: it re-validates in its write transaction as
  [[2026-09-10-bracket-non-transactional-calls-with-staleness-checked-transactions]]
  requires, or it records its own decision.
- [[2026-09-10-side-effects-follow-the-commit]] registers an effect that
  announces a write with `runAfterCommit`. That hook takes a synchronous
  callback, and a callback's failure is logged and never reaches the caller.
- [[2026-10-05-tenant-scope-propagation]] lets code leave a tenant scope only
  through `runDetachedAsSystem`, and only to open shared I/O resources.
  `runAsSystem` inside a tenant scope throws. The route calls the restart from
  inside the session's tenant scope and the request's trace context.
- [[2026-10-29-custom-route-composition-root-dependencies]] hands the routes a
  `mailLiveSync` placeholder whose calls refuse, until the root gains a
  per-mailbox control.

The bodies of those decisions stay as they are. This record decides the four
open points for the reauthorization and for `restartAccount`.

## Decision

### 1. The reauthorization's write reads what it decides from in its own transaction, under row locks

The branch reads no tenant data before the provider call: the consumed state
names the mailbox and the provider, and nothing else is looked up. There is no
snapshot to re-validate after the call, so the bracket decision's read
transaction is not used. One transaction, opened by `withTransaction` without an
isolation option (READ COMMITTED), runs `replaceMailboxCredential`:

1. It reads the Mailboxes item without a lock. A missing, soft-deleted or
   foreign item, or one whose `provider` is not the state's, ends the
   transaction with 400 `validation_failed` for the state. This read is not a
   guard of the write. It keeps the next step from running for an id that is no
   mailbox of the tenant. For another tenant's mailbox that step would collide
   with that tenant's row, which row-level security hides, and fail with an
   unexpected error.
2. `ensureMailAccountSyncState` creates the mailbox's sync state row when no
   discovery pass has seeded it yet, with the sync mode of the state's provider.
   An existing row keeps its sync mode.
3. `lockMailAccountSyncState` takes the sync state row `FOR UPDATE`.
4. `lockItemById` takes the Mailboxes item `FOR UPDATE`, and the condition of
   step 1 is checked again on the locked row. The sync mode of the row locked
   in step 3 must also be the one of the state's provider: `gmail_api` for
   `gmail`, `graph_api` for `outlook`. Another sync mode ends the transaction
   with the same 400. This is the guard.
5. It reads `provider_account_address`. A stored address that differs from the
   signed-in one, compared after `normalizeEmailAddress`, ends the transaction
   with 400 `mail_reauth_wrong_account`. When no address is stored,
   `recordProviderAccountAddress` stores the signed-in one. The partial unique
   index `mail_account_sync_state_tenant_provider_address_uq` refuses an address
   that another mailbox of the tenant records. That violation aborts the
   transaction, and the route answers it with the same 400
   `mail_reauth_wrong_account`: the account belongs to another mailbox.
6. `storeCredential` replaces the `oauth2_refresh_token`, and
   `enqueueMailAccountSync` queues the mailbox's sync.

The sync mode decides next to the `provider` property because the two can
differ. `Mailboxes.provider` is owned by the user, so a generic item write
changes it. The sync job and the hosted lifecycles dispatch on `sync_mode`, and
`ensureMailAccountSyncState` never changes it on an existing row. An IMAP
mailbox relabelled `gmail` still presents its stored credential as its IMAP
password, and a Gmail mailbox relabelled `outlook` still sends its own to
Google's token endpoint. Replacing either credential with a refresh token of
the provider the label names would stop the mailbox's sync and hand that token
to a server it was not issued for.

The reauthorize route makes the same check before it stores a state, and
answers 400 `validation_failed` for the `provider` field. It locks the Mailboxes
item and reads the sync state row without a lock, so its answer is an early
refusal and no guard: a row can be seeded after the read. Locking the row there,
after the item, would take the two rows in the opposite order to the one below.

The lock order is the sync state row first and the Mailboxes item second. The
sync job's transactions take the same two rows in that order: they update the
sync state row (`recordSyncError`, `recordGmailActivity`, `recordGraphActivity`,
`recordImapActivity`) and then write `Mailboxes.syncStatus`. The opposite order
would deadlock against a sync that fails while the user signs in again.

Two reauthorizations of one mailbox both take the sync state row in step 3, so
the second one waits for the first one's commit and reads the address it stored.

A refused reauthorization rolls back whole: no token, no address and no job. The
state stays consumed in every case, as step 1 of the connect decision says. The
branch does not write `Mailboxes.syncStatus`, the history cursor, the delta link
or `gmail_watch_email_address`. The watch address stays with the Gmail watch
lifecycle, which stores it again when the restarted lifecycle registers its
watch.

### 2. The restart is an awaited call after the commit, not an after-commit callback

After `withTransaction` resolved, the route awaits
`mailLiveSync.restartAccount(mailboxItemId)` and answers 200 with the mailbox id.
The restart is asynchronous work whose failure the caller must see, which
`runAfterCommit` cannot give. A rejected restart propagates as an unexpected
error: the adapter logs it and answers a generic 500, while the token is
replaced and the sync is queued. The user signs in again, which repeats the
restart.

The route reads the `mailLiveSync` member of its dependencies right after the
state is consumed, before the provider call. A deployment that did not configure
the member replaces no token. The handler lives in `@semprec/data`, which cannot
import the service's `requireCustomRouteDependency`. It reads the member itself,
once per request, and fails with a plain error that the adapter answers with a
generic 500, as `requireOauthClient` does for the OAuth client of the connect
routes.

### 3. `restartAccount` on the live-sync root

`restartAccount(mailboxItemId)` stops the hosted entry through `stopHosted`, the
path a deactivated account takes, and then hosts a new lifecycle from the root's
lifecycle factory for the entry's tenant and sync mode. It does so whether or
not the old `start()` succeeded: an entry whose start failed stays hosted, so it
is found. The new lifecycle is created after the call began, so its `start()`
reads what the caller committed before it called.

- **Not hosted means nothing to do.** An account without a hosted entry is left
  to the next discovery pass, which creates its lifecycle then. That covers an
  account not discovered yet, a retired one, one whose lifecycle a pass or
  another restart is replacing at that moment, and every account after `stop()`.
- **A pass may host the account while the old lifecycle stops.** The restart
  then keeps that lifecycle and creates none. Whenever it does create one, it
  checks for an entry and sets its own without an `await` in between.
- **`stop()` wins.** A restart whose old lifecycle is still stopping when
  `stop()` runs hosts nothing afterwards. A restart that already hosted its new
  lifecycle has it stopped by `stop()` like any other entry.
- **`stopTenant` waits for a restart in flight**, as it waits for a pass, and
  then stops what the restart hosted. A restart that begins while `stopTenant`
  is already waiting is not waited for, and can host a lifecycle of that tenant
  after `stopTenant` resolved. The next discovery pass retires it, because
  discovery does not list a tenant that is not active.
- **A failed start of the new lifecycle** is reported through
  `onLifecycleError` and leaves the entry hosted, as in a discovery pass. The
  restart resolves. A lifecycle factory that throws rejects the restart and
  leaves the account unhosted until the next pass.

**The restart runs in the root's own async context.** `createMailLiveSyncRoot`
captures the context it is called in with `AsyncLocalStorage.snapshot()`.
`restartAccount` runs its work through that snapshot, inside
`runAsSystem("mail:liveSync")`, the scope a discovery pass runs in. Two things
require it:

- The per-account heartbeat ticks inside `runAsSystem`, which throws inside a
  tenant scope. Started from the request, every tick would be refused.
- A lifecycle's timers and sockets keep the context that created them. Started
  from the request, they would carry that request's trace context for as long as
  the mailbox stays hosted, and every sync they enqueue would carry its trace id.

This is a second way out of a tenant scope, next to `runDetachedAsSystem`, and
it is confined to this method. It cannot be used to reach another tenant:

- The tenant the lifecycle then runs in is the one the root recorded for the
  hosted entry when discovery found the mailbox. It never comes from the caller.
- `restartAccount` reads the caller's tenant scope before it leaves the context.
  A caller inside a tenant scope restarts only an entry hosted for that tenant.
  An entry of another tenant is treated as not hosted.

A root created inside a tenant scope cannot restart: `runAsSystem` throws there
and the restart rejects. `semprec-api` creates the root at module level, outside
any scope.

### 4. The routes reach the root through a control that is bound after the dispatcher

`createMailLiveSyncControl()` (`backend/services/semprec-api/src/mailLiveSyncControl.ts`)
returns the `mailLiveSync` member and a `bind(root)` function. `serve.ts` puts
the control into the custom-route dependencies before it creates the dispatcher,
and binds the root right after creating it, before the server listens. The
control's `restartAccount` forwards to the bound root. Called while no root is
bound it refuses with `CustomRouteConfigurationError`. `startMailbox` and
`stopMailbox` still refuse on every call: the root has no start or stop of one
mailbox.

## Consequences

- No transaction is open during a provider request, and no tenant data read
  before that request decides the write.
- A mailbox whose sync mode is not its `provider`'s cannot be reauthorized. An
  IMAP mailbox labelled `gmail` or `outlook` keeps its password, and a mailbox
  relabelled from one of the two providers to the other keeps its token; it can
  be reauthorized again once its `provider` names what it syncs with. A mailbox
  without a sync state row is decided by its `provider` alone and gets that
  provider's sync mode in the same transaction.
- A sign-in with another account changes nothing. A mailbox that records no
  address takes the address of the first account that reauthorizes it, unless
  another mailbox of the tenant records that address.
- While it holds the two row locks, the write can wait for the mailbox's
  `external_credentials` row. `refreshAndPersistAccessToken` holds that row
  across its provider request
  ([[2026-11-02-mail-oauth-rotation-holds-the-credential-lock-through-refresh]]).
  The wait ends at the latest with the connection's statement timeout. Whichever
  of the two commits last decides the stored token: a reauthorization that waits
  overwrites the rotated token, and a refresh that takes the row afterwards
  reads the new one.
- After a reauthorization one lifecycle is hosted for the mailbox, and it read
  the new token. This also holds when the previous `start()` had failed, which a
  discovery pass does not repair while the mailbox keeps its sync mode.
- A restart can fail after the token was replaced. The response is then a 500
  for a reauthorization whose database part succeeded.
- The response waits for the old lifecycle's `stop()` and the new one's
  `start()`. The Gmail watch and Graph subscription lifecycles await their
  renewal loop in `stop()`, and that loop can be inside a token refresh or a
  provider request. Each of those has its own timeout; the restart adds none.
- A mailbox the root does not host at that moment gets its new lifecycle on the
  next discovery pass, within the discovery interval.
- A later caller of `restartAccount` from inside a tenant scope, such as gh-1481
  for a rotated token, gets the same context rule without further work. A
  caller that needs to restart a mailbox of another tenant has to call from a
  system scope.
- The provider lookup of the branch is the connect flow's, so Gmail's send-as
  list is requested too and not used.
