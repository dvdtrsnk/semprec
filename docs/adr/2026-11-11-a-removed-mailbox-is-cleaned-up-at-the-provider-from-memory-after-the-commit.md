---
status: accepted
date: 2026-11-11
area: [backend]
supersedes: []
superseded-by: null
---

# A removed mailbox is cleaned up outside the database after the commit, from values held in memory, the live-sync root stops one mailbox, and a Google grant is ended only for the one mailbox that records its account

## Context

[[2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status]] removes a mailbox in one
transaction that deletes its credential and its sync state. Three things outside Semprec's database are
left after that commit:

- the mailbox's hosted live-sync lifecycle (`mail/mailLiveSyncRoot.ts`). It keeps the credential it decrypted
  at its start, an IMAP lifecycle keeps its IDLE loops, and discovery retires it only on its next pass, up to
  60 seconds later;
- the Gmail watch or the Microsoft Graph subscription registered for the mailbox at the provider;
- the OAuth grant, which the provider still honors for anyone who holds the refresh token.

Issue gh-2030 cleans these up. Its issue text decides that the cleanup is best effort and never fails the
removal. The points below had a real alternative.

- **Where the refresh token comes from.** Cancelling the watch or the subscription and revoking the grant
  need the mailbox's refresh token, and the removal deletes the credential row.
  [[2026-09-10-side-effects-follow-the-commit]] sends work that must be awaited after a commit to a queue job
  written in the same transaction. A job would need the token in its payload, which stores it in clear text
  in the queue's table, or the credential row would have to outlive the removal until the job ran, which
  leaves a usable secret for a mailbox the user removed.
- **When the provider is called.** Calling the provider inside the transaction, before the delete, puts
  network calls under the mailbox's sync guard and its row locks, and a rollback after a successful
  revocation leaves a live mailbox whose grant is gone.
- **Which provider.** The Mailboxes item has a `provider` property, and the mailbox's
  `mail_account_sync_state` row has a sync mode. The user owns the property and a generic item write changes
  it. The sync job and the hosted lifecycles dispatch on the sync mode, so the sync mode names the provider
  the stored credential is sent to.
  [[2026-11-11-mailbox-reauthorization-restarts-the-hosted-lifecycle-in-the-live-sync-roots-context]]
  describes the same difference for the reauthorization. A cleanup that followed the property would send the
  Microsoft token of an Outlook mailbox relabelled `gmail` to Google.
- **The hosted lifecycle.** [[2026-10-29-custom-route-composition-root-dependencies]] gave the custom routes
  a `mailLiveSync` member. The reauthorization decision named above gave the live-sync root
  `restartAccount`, bound the member's `restartAccount` to it through `createMailLiveSyncControl`
  (`services/semprec-api/src/mailLiveSyncControl.ts`), and left the member's `stopMailbox` refusing every
  call, because the root had no stop of one mailbox. Leaving the lifecycle to discovery needs no such stop.
- **Microsoft.** The Microsoft identity platform has no call that revokes one application's refresh token.
  Microsoft Graph's `revokeSignInSessions` invalidates every refresh token of the user, for every
  application, needs a permission the connect flow does not request and is not available for personal
  accounts.
- **Google.** The revocation endpoint ends the account's whole grant to this deployment's Google project,
  not one token. Gmail's `users.stop` takes no watch id: it ends the push notifications of the account.
  Migration 0071 lets one Google account be connected to mailboxes of several tenants, and a removal in
  one tenant must not change the state of a mailbox in another. The sync state row of a `gmail_api`
  mailbox records the account's address in `gmail_watch_email_address`: the OAuth connect flow stores it
  with the mailbox and every watch registration replaces it, both from the provider's own answer.
  `route_gmail_address` ([[2026-10-07-cross-tenant-router-functions]]) maps such an address to every
  mailbox that records it, in any tenant.

## Decision

1. **The removal transaction reads what the cleanup needs, into memory only.** Before its first delete,
   `removeMailbox` reads through `readMailboxRemovalCleanupInput`
   (`mail/mailboxRemovalProviderCleanup.ts`), from the `mail_account_sync_state` row it has locked: the
   sync mode, whether a Gmail watch is recorded (`gmail_watch_expires_at` is set) and the recorded Graph
   subscription id. The sync mode names the provider: `gmail_api` is Google and `graph_api` is Microsoft.
   The `provider` property is not read. A mailbox without a sync state row and a mailbox in sync mode
   `imap` have no work at the provider.
   For a `gmail_api` mailbox whose credential is an `oauth2_refresh_token` it then reads whether the
   mailbox is the only one that records its Google account (point 7).
   It then reads the refresh token. The token is decrypted with `getDecryptedCredential`, which writes its
   `credential_access_log` row as actor `user` with the purpose `mailbox_removal` and, when the caller
   names the removing user as the route does, that user's id. It is decrypted only when a step below needs
   it: for such a `gmail_api` mailbox that is the only one recording its account, and for a `graph_api`
   mailbox with an `oauth2_refresh_token` credential and a recorded subscription. A credential of another
   type is never read.
   The transaction returns these values to its caller, which hands them to the cleanup. They are written
   to no table, no job payload and no log.
   A credential that cannot be decrypted does not fail the removal: the cleanup then has no token and
   reports the steps that needed it. A statement of the read that fails does fail the removal, like any
   other statement of the transaction.
2. **The cleanup runs after the commit, awaited by the request, and cannot fail the removal.**
   `removeMailbox` awaits `cleanUpRemovedMailbox` after its `withTransaction` call returned, so it runs
   only for a removal that committed. It is not a `runAfterCommit` callback, because those are synchronous
   and this work is awaited, and it is not a queue job, for the reason given in the Context. A step
   that fails does not make it reject. Its steps run in this order, and each runs whether or not an
   earlier one failed:
   - `liveSyncStop`, for every mailbox: the hosted lifecycle is stopped through the `mailLiveSync` member
     of the custom-route container, first, so that it renews nothing after the next two steps;
   - `gmailWatchStop` (`POST https://gmail.googleapis.com/gmail/v1/users/me/stop`) for a `gmail_api`
     mailbox with a recorded watch, or `graphSubscriptionDelete`
     (`DELETE https://graph.microsoft.com/v1.0/subscriptions/{id}`) for a `graph_api` mailbox with a
     recorded subscription. Each needs an access token, which `refreshAccessToken` exchanges the refresh
     token for without persisting anything; a refresh token the provider rotates in that answer is dropped.
     A 404 from the subscription delete counts as done;
   - `tokenRevocation` (`POST https://oauth2.googleapis.com/revoke`, the token in the request body) for a
     `gmail_api` mailbox, last, because the watch stop needs a token of the grant it ends.

   The two steps at Google make their calls only under point 7.

   The live-sync stop and each request to a provider are limited to 10 seconds; the token exchange has
   `refreshAccessToken`'s own limit of 15 seconds. A request that reaches its limit is aborted. A
   live-sync stop that reaches it is reported and goes on in the background.

3. **A failed step is logged with a fixed classification only.** One `warn` line per failed step carries the
   mailbox id, the step and one of `notConfigured`, `credentialUnavailable`, `timeout`, `providerRejected`
   and `failed`. The caught error is not logged, not even its name: a provider or network error can hold
   the request, and the request holds the token. `refreshAccessToken` logs its own line for a token
   exchange whose request failed; that line carries a fixed stage name and nothing of the error.

   `timeout` means that the live-sync control, or the provider in one of the step's requests, did not
   answer within the limit. `providerRejected` means that the provider answered one of them with a status
   outside 2xx, other than the 404 of point 2. `failed` is everything else: a network error, a control
   that rejected, an answer to the token exchange that could not be read or holds no access token. The
   token exchange of a step is classified like its call to the provider. `refreshAccessToken` reports only
   a 400 or 401 as a typed error, so the cleanup hands it a `fetch` that records what the exchange's
   request came to: ended unanswered by the exchange's own limit, or answered with which status.

   A step skipped under point 7 is not a failure. It logs one `info` line with the mailbox id, the step
   and `accountShared` or `accountUnknown`, and nothing of the mailbox that shares the account.

4. **The live-sync root stops one mailbox.** `MailLiveSyncRoot.stopMailbox(tenantId, mailboxItemId)` first
   waits for every discovery pass and every `restartAccount` in flight, because a pass that listed the
   mailbox before the removal committed, or a restart, may still host it. It then stops the mailbox's entry
   through the path a deactivated account takes, when the entry is hosted for `tenantId`; an entry of
   another tenant, or no entry, is left alone. It finally waits for a stop of that entry another caller
   started, so it resolves only once the lifecycle's `stop()` has finished. The lifecycle is stopped once.
   It does not keep a later pass from hosting the mailbox again; the Mailboxes item being in the trash
   does, and the removal committed that before the call.

   Unlike `restartAccount`, the stop runs in the caller's async context, which for the removal is the
   request's tenant scope. A stop starts no heartbeat, timer or socket that would keep that context. The
   lifecycle's `stop()` runs in the scope of the tenant the root recorded for the entry, which for the
   removal is the scope it is already in. A caller inside the scope of a tenant other than `tenantId`
   stops nothing: the entry's scope cannot be entered from there, and the entry would leave the root's
   bookkeeping with its lifecycle still running.

   `createMailLiveSyncControl` now forwards the member's `stopMailbox` to the bound root, as it forwards
   `restartAccount`, and refuses with `CustomRouteConfigurationError` while no root is bound.
   `startMailbox` still refuses every call: the root has no operation that starts one mailbox. This
   delivers the stop that point 4 of the reauthorization decision left out; that record stays as it is.

5. **A missing dependency fails a step, not the request.** Point 2 of
   [[2026-10-29-custom-route-composition-root-dependencies]] answers a request whose route misses a member
   with a 500. The removal route does not: when the cleanup runs, the removal has committed, so a missing
   `mailLiveSync` or OAuth client, or a control that is not bound yet, is the `notConfigured` or `failed`
   outcome of one step.
6. **A Microsoft token is not revoked.** No call is made, for the reason given in the Context. The stored
   credential is deleted, and the token the cleanup held is dropped when it ends.
7. **A Gmail watch stop and a Google revocation are made only for a mailbox that is the only one recording
   its Google account.** Both act on the whole account, so the removal of one mailbox would end the grant
   and the push notifications of every other mailbox connected to it, in any tenant. Inside the removal
   transaction, before the sync state row is deleted, `getGmailAccountUse`
   (`mail/mailAccountSyncStateStore.ts`) reads the mailbox's own `gmail_watch_email_address` under
   row-level security and calls `route_gmail_address` with it. It is one statement, and it keeps only
   whether the function returned a row other than the mailbox itself, so no id of another tenant's
   mailbox leaves the database. It has three answers:
   - `sole`: no other mailbox records the account. The token is decrypted and both steps run.
   - `shared`: another `gmail_api` mailbox records it, of this or of another tenant; a mailbox in the
     trash that kept its sync state row counts. No call is made at Google, the token is not decrypted,
     and each skipped step logs `accountShared`.
   - `unknown`: the mailbox's row records no address, so the cleanup cannot tell whether another mailbox
     depends on the account. It makes no call either, and each skipped step logs `accountUnknown`. The
     connect flow records the address with the mailbox, so this is a mailbox that was created another
     way and never registered a watch.

   The removal answers the same in all three cases. The router functions were introduced to map an
   external identifier to its tenant before any tenant is known. Here one is called from inside a
   tenant's transaction, for a question that has no answer under row-level security, and what leaves the
   statement is a boolean.

## Consequences

- The cleanup is not retried. A process that ends between the commit and the end of the cleanup leaves the
  watch or subscription to expire at the provider and the Google grant in place until the user removes it
  in the Google account. The lifecycle is gone with the process, and no later discovery pass hosts a
  trashed mailbox.
- The removal request answers only after the cleanup. When every step runs into its limit, that is up to
  45 seconds for a `gmail_api` mailbox with a watch and 35 seconds for a `graph_api` mailbox with a
  subscription.
- Removing a `gmail_api` mailbox ends the Google account's grant to the deployment and its push
  notifications only when no other mailbox records the account. While another one does, the removed
  mailbox's token stays valid at Google, as a Microsoft token does; Semprec keeps no copy of it. The
  grant ends with the removal of the last mailbox that records the account, or when the user removes it
  in the Google account.
- The lookup and the calls at Google are not one atomic step, and no lock spans them. Two removals of
  mailboxes on one account that run at the same time each see the other's row, so both leave the grant
  in place. A mailbox connected to the account after the removal's lookup and before its revocation loses
  the grant it just received and needs reauthorization; the steps between the two take up to 35 seconds
  when each runs into its limit.
- The lookup finds what the sync state rows record. A mailbox that holds a Google grant and has no
  `gmail_api` row with the account's address is not found; no connect flow creates one.
- The answer of a removal does not show whether the calls were made. A removal that skips them returns
  sooner than one that makes them, which is the one thing the removing user could observe about another
  mailbox on an account they can sign in to.
- A Microsoft grant stays valid at Microsoft until it expires or the user removes it there. Semprec keeps
  no copy of its token.
- A mailbox's `provider` property has no effect on the cleanup. A mailbox that was created through a
  generic item write, never connected and never listed by a discovery pass has no sync state row and gets
  no provider step; it has no stored OAuth credential either.
- A mailbox whose stored refresh token the provider no longer accepts logs `providerRejected` for the steps
  that used it.
- The generic `DELETE /api/items/:id` still trashes a Mailboxes item without the removal and so without this
  cleanup. Issue gh-2031 will refuse it.
- `stopMailbox` waits for discovery passes and restarts in flight, and each of them awaits the `start()` of
  a lifecycle it hosts. A slow start therefore delays the stop; the cleanup's limit bounds what the request
  waits for.
- A `restartAccount` that begins while `stopMailbox` is already waiting is not waited for. A
  reauthorization that committed just before the removal can therefore host a new lifecycle for the removed
  mailbox after `stopMailbox` resolved. The next discovery pass retires it, because discovery does not list
  a trashed mailbox.
- What discovery inserts is unchanged: a pass that listed the mailbox just before the removal committed can
  still insert a `mail_account_sync_state` row for it afterwards.
