# Mail and Inbox

The rules of the mail domain (mailboxes, provider connections, sync, threads, drafts, sending) and of the
Inbox domain (capture, attachments, the tick, proposal cards). Mail code lives in
`backend/packages/data/src/mail/`, Inbox code in `backend/packages/data/src/inbox/`. General mechanisms are
described elsewhere and only referenced here:

- choke point, ownership, value links, trash/restore/purge hooks: [data-model-and-writes.md](data-model-and-writes.md)
- `withTransaction`, side effects after commit, queue lanes and job keys: [transactions-and-side-effects.md](transactions-and-side-effects.md)
- RLS, tenant scope, cross-tenant router functions, credential encryption: [tenancy-and-security.md](tenancy-and-security.md)
- outbound address policy, timeouts, shutdown, logging, private provider failures: [edges-io-and-errors.md](edges-io-and-errors.md)
- approvals, module agent tools, MCP exposure, AI gateway: [agents-approvals-and-ai.md](agents-approvals-and-ai.md)
- recordings, transcription intake, Files and blobs: [domain-calendar-tasks-and-media.md](domain-calendar-tasks-and-media.md)

## Mailboxes and connections

### Internet accounts and service switches

- A Mailboxes item is an internet account (label "Internet accounts"; the key `mailboxes` and the
  `/api/mail/mailboxes*` routes stay). Its user-owned checkboxes `mailEnabled` and `calendarsEnabled` are the
  service switches. Unset reads as the default, Mail on and Calendars off (`isMailEnabled`,
  `areCalendarsEnabled` in `mail/mailboxServiceHooks.ts`); the connect flows write both explicitly. Both
  appear in the `GET /api/mail/mailboxes` and `/:id` rows. Both services may be off; the account keeps its
  sign-in until it is removed. `calendarsEnabled` drives the account's calendar sync, whose lifecycle the
  same hooks start and stop (see the calendar sync in
  [domain-calendar-tasks-and-media.md](domain-calendar-tasks-and-media.md#internet-account-calendar-sync)).
- `mail_account_sync_state.sync_paused_at` is what the mail lifecycle reads: set, the account has Mail off.
  The sync pass (prologue and again under the guard), the sweep (`listAccountsDueForSync`), live-sync
  discovery and the mail-sync heartbeat expectation skip a paused account; `sendDraftEmail` refuses it.
- Switching (`mailboxServiceItemUpdatePreLockHook`, `mailboxServiceItemUpdateHook`): a write that patches
  `mailEnabled` takes the mailbox sync guard (≤ 15 s, else 409 `mailbox_sync_busy`) and then the sync state row
  `FOR UPDATE` before the update locks the Mailboxes item, the order of a removal. The update hook decides by
  the locked row, so a repeated write changes nothing.
  - Off (`pauseMailAccountSync`), in the write's transaction: set `sync_paused_at` (seeding a row for a
    never-connected mailbox) and reset the account to never synced (Gmail history id, Graph delta link,
    initial-sync mark, next expected activity and failure record cleared); delete the folder sync states;
    resolve the mailbox's Semp problem as `sourceDeleted`; enqueue the mail-off `mailboxRemoval` job. After
    the commit the live sync is stopped through the stop `bindMailboxServiceLiveSyncStop` bound
    (`semprec-api` binds `mailLiveSyncControl.stopMailbox`); a failed stop is logged, and in a process without
    a binding the next discovery pass unhosts the account. The item, credential, server settings, sync mode,
    provider account and Gmail routing addresses and the Graph subscription id stay; the provider-side Gmail
    watch and Graph subscription are not cancelled, their renewals stop with the lifecycle and they expire,
    and a notification that still arrives only enqueues a pass that skips.
  - On (`resumeMailAccountSync`): clear `sync_paused_at` and enqueue `mailAccountSync` in the same
    transaction; discovery hosts the live sync again on its next pass. The mail downloads as for a new account.

### Server settings and outbound connections

- IMAP/SMTP settings live in `mail_account_server_settings` (`mail/mailServerSettingsStore.ts`); the password
  stays in `external_credentials`. Database CHECK constraints repeat the port, security and all-or-none rules.
- A generic account may also store `caldav_url`, the start of its calendar discovery: an `https:` URL on the
  default port without userinfo whose host follows the host rules below (`normalizeCalDavUrl`, ≤ 2048 chars).
- The port must be one of 993, 143, 465, 587 (`MAIL_SERVER_PORTS`); security is `tls` or `starttls`.
- The host must be a lower-cased DNS name (≤ 253 chars). IP literals in any notation, `localhost` and names
  ending in `.localhost`, `.local` or `.internal` are refused. This is an input contract only.
- Every connection to a tenant-chosen host is opened through `mail/mailServerConnections.ts`:
  `openImapFlow()` (the one IMAP connect step; returns only a _connected_ `ImapFlow`), `openImapConnection()`
  (sync wrapper `ImapFlowMailClient`), `createSmtpTransporter()`, and the verification helpers
  `verifyImapServerConnection()` (and `verifyImapServerConnectionAndListFolders()`, which lists the folders on the
  verified connection) / `verifySmtpServerConnection()`. No other code constructs `ImapFlow` or a
  nodemailer transport for a tenant host.
- These factories resolve the name once through the outbound address policy (`createPolicyLookup` in
  `net/outboundAddressPolicy.ts`): IMAP sets `tls.lookup` + `tls.servername`; SMTP hands nodemailer a socket
  opened by `getSocket` with the policy lookup. Certificates are validated against the host name.
- A refused address and every connect/TLS failure become `MailServerUnreachableError`
  (`mail_server_unreachable`) without cause or address; a refused address is indistinguishable from an
  unreachable server. Authentication failures keep their own classification. imapflow's logger is disabled.
- IMAP IDLE (`mail/imapIdleClient.ts`, `mail/imapIdleLifecycle.ts`) receives a connected client from
  `openImapFlow()` with `maxIdleTime`/`socketTimeout`/`autoIdleDelay` options; the IDLE transport never connects
  itself. `autoIdleDelay` is 0 on that connection, which issues no command after its SELECT, so IDLE (the only time a
  server reports a delivery unasked) starts at once instead of after imapflow's 15 s default.
- Tests reach local fake servers only through `allowLoopbackOutboundForTests()`. Host egress filtering stays
  the second layer.

### Password connect and credential verification

`POST /api/mail/mailboxes` (`mail/mailboxPasswordRouteHandlers.ts`) connects an iCloud or generic IMAP mailbox.

- Order: validate body → duplicate rule (`mailboxHoldsAddress`, READ COMMITTED read, 409
  `provider_account_already_connected`) → throttle → outside any transaction and concurrently,
  `verifyMailCredentials` with `listFolders` and, for a generic body with `caldavUrl`, the `verifyCalDav` member
  (`verifyCalDavServer`, CalDAV discovery to the calendar home with the same login; 400 `caldav_auth_failed`,
  `caldav_server_unreachable` or `caldav_server_invalid`) → `createPasswordMailbox` in one READ COMMITTED transaction
  that re-reads the duplicate rule before writing.
- Both verifications settle before the route answers. The mail failure is answered before a CalDAV failure; a failure
  that is not answered is logged (verification and error name only).
- The folders are listed on the IMAP verification's own connection: once its login succeeded, the attempt sends LIST
  (imapflow `list()` without a status query, so no STATUS) under its own 15 s deadline and then closes the connection
  as any attempt does. What the client and its sockets report while the LIST runs is the listing's and never fails
  the verification. `createPasswordMailbox` writes the Drafts and Sent Folder items among them
  (`ensureComposeFolders`, `mail/folderDiscovery.ts`) with the `providerId`, name and purpose the first sync pass
  derives (`imapProviderFolder`), so the account drafts and sends before that pass, which finds them by `providerId`.
  A failed or expired listing is logged (error name only) and the mailbox is connected without them.
- An address is held when `mail_account_sync_state.provider_account_address` records it or a live Mailboxes
  item's `addresses` list names it (`mailboxHoldsAnyAddress`, `mail/mailboxAddresses.ts`). A trashed mailbox does not
  count: its removal deleted its sync state row, so its address can be connected again. The partial unique index
  `mail_account_sync_state_tenant_provider_address_uq` decides concurrent connects; the reads take no row lock.
- Throttle: action `mailboxCredentialVerification`, 10 verifications per 15 minutes **per user id**, in process
  memory (`services/semprec-api/src/clientIpThrottle.ts`), handed to custom routes as the `throttle` member.
  `tryAcquire` runs directly before the verification with no `await` between; a counted attempt is never
  released. Refusal is `RateLimitedError` → 429 `rate_limited` with `Retry-After`. Without a throttle the
  route fails before contacting any server.
- `verifyMailCredentials` (`mail/mailCredentialVerification.ts`) verifies IMAP and SMTP concurrently, each trying
  its candidates in order; both settle before it returns, and when both fail the IMAP failure is thrown. Each attempt
  has a 15 s whole-attempt deadline spanning DNS, connect, TLS and login. It owns its sockets: on expiry it destroys the owned socket (so `connect()`
  rejects through the library's handlers), fences late DNS/connect callbacks and waits for real socket close
  before trying the next candidate or returning. The one private accessor reads ImapFlow 1.7.6's `socket`
  property behind a runtime `net.Socket` check; a library upgrade must re-prove it with the real-library tests.
- Credentials are never sent before verified TLS (STARTTLS upgrades first). `mail_tls_failed` is returned
  only for an unambiguous machine-readable TLS failure; ambiguous SMTP `ESOCKET`/`ECONNECTION` stays
  `mail_server_unreachable`. Across candidates: auth rejection, else definite TLS failure, else unreachable.
- At its public boundary an unknown failure becomes a fresh fixed generic `Error` (no cause, no candidate
  continuation). Verification saves nothing.

### Password sign-in again

`PUT /api/mail/mailboxes/:id/password` (`createMailboxPasswordReplaceRouteHandler`) replaces the password of an
existing iCloud or generic mailbox; its mail, folders and threads stay.

- Body `{ password, username? }` (strict, same bounds as the connect); `username` defaults to the stored one. A
  malformed, unknown, foreign or trashed id is 404 `not_found`. A mailbox whose `provider` is not `icloud`/`generic`,
  that lacks stored IMAP or SMTP settings, or whose sync mode is not `imap` is 409 `mailbox_not_password`.
- Order: read the account → throttle (`mailboxCredentialVerification`, as the connect) → outside any transaction and
  concurrently, as the connect, `verifyMailCredentials` against the stored hosts (no folder listing) and, with
  Calendars on, `verifyCalDav` at the CalDAV start (`https://caldav.icloud.com/` for iCloud, else the stored
  `caldav_url`; none without one) → one READ COMMITTED
  transaction: unlocked sanity read → `ensureMailAccountSyncState` → lock sync state row → lock Mailboxes item →
  re-check on the locked rows → `storeCredential`, the verified endpoints and the user name
  (`upsertMailServerSettings`), `clearMailSyncFailure` (last error, failure kind, failing since, next expected
  activity), `clearCalendarSyncReauthorization` (`needsReauthorization` → `never`), enqueue `mailAccountSync` and,
  with Calendars on, `calendarAccountSync`. After the commit the route awaits `mailLiveSync.restartAccount`; a
  failed restart is logged (`mailboxItemId`, `errorName`) and the route still answers 200, because the replacement
  is committed and the queued pass reads the new password. Refusals answer 400 with the connect's codes and change
  nothing. `syncStatus` is left to the queued pass.

### OAuth connect and reauthorization

`POST /api/mail/mailboxes/oauth/complete` (`mail/mailOauthRouteHandlers.ts`); states in `mail_oauth_states`.

- Scopes per service (`mail/oauthServiceScopes.ts`): Mail asks Gmail `gmail.modify`, `gmail.send` and Microsoft
  `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `User.Read`; Calendars adds Google
  `https://www.googleapis.com/auth/calendar` and Microsoft `Calendars.ReadWrite`. The mail scopes are part of every
  sign-in: the account identity is read through them, and a reauthorization replaces the one credential mail sync
  uses. Google is asked with `prompt=consent`, so its consent screen lists every scope asked for.
- `POST /api/mail/mailboxes/oauth/start` takes `{ provider, services?, redirectTarget? }`; `services` defaults to
  `["mail"]` and must include `mail` for a new account. The new mailbox's `calendarsEnabled` is whether `calendars`
  was asked for. `POST /api/mail/mailboxes/:id/reauthorize` takes `{ services?, redirectTarget? }` and asks for the
  mail scopes, the calendar scope when Calendars is switched on, and whatever `services` adds. The state row stores
  the asked-for `services` and the `redirect_target`.
- The token response's space-separated `scope` is stored per account in `mail_account_sync_state.granted_scopes`
  (`recordGrantedOauthScopes`) on connect and reauthorization, replacing the previous grant; a response without
  `scope` granted what was asked for (RFC 6749 §5.1). A Google user can leave the calendar box unchecked, so the
  stored grant, not the request, decides.
- `calendarStatus` on the mailbox rows (`calendarStatusOf`): `off` while Calendars is off; `needsConsent` for a
  `gmail_api`/`graph_api` account whose granted scopes lack the calendar scope (Graph's resource-qualified names in
  any case count); otherwise the stored status of the account's calendar sync (`never` before its first pass).
  Switching Calendars on queues a calendar sync pass; for an OAuth account without the calendar scope the client
  then reauthorizes with `services: ["mail", "calendars"]`.
- `GET /api/mail/oauth/callback` (public, `services/semprec-api/src/mailOauthCallbackHandler.ts`) validates the
  query first, then `resolveMailOauthRedirectUrl` looks the state up: `route_mail_oauth_state` names the tenant of an
  open (unused, unexpired) state by its hash, and the target is read inside that tenant. For `redirectTarget: "app"`
  it answers 302 to `semprec://oauth?state=…&code=…` (or `&error=…`); the URL comes only from the stored state. Any
  other state, unknown, used or expired ones included, gets the JSON echo `{ state, code }` /
  `{ state, providerError }`. The callback reads only and writes nothing.

1. `consumeMailOauthState` marks the state used (guarded single `UPDATE`) and commits **before** the provider
   call. A state admits exactly one exchange; every later failure leaves it used and the user restarts.
2. Code exchange and account/alias lookups run outside any transaction.
3. Connect: `createConnectedMailbox` writes item, addresses, sealed refresh token, sync state with
   `provider_account_address`, the Drafts and Sent Folder items and the first sync job in one READ COMMITTED
   transaction. Gmail's are the system labels `DRAFT` and `SENT` (`GMAIL_SYSTEM_FOLDERS`); Graph's are read before the
   transaction (`GET /me/mailFolders/drafts` and `/sentitems`, with the identity reads' timeout and cap), and a failed
   read is logged and leaves that folder to the first pass. The address unique
   index decides duplicates; after the rollback a separate read names the existing mailbox (409
   `provider_account_already_connected`, `details.mailboxId` possibly `null`).
4. For Gmail the connect writes `gmail_watch_email_address` once, from `users.getProfile`
   (`recordGmailWatchEmailAddress`). Afterwards only the Gmail watch lifecycle writes that column. The value
   never comes from the request or the alias list, because `route_gmail_address` routes across tenants by it.

- Reauthorization (`POST /api/mail/mailboxes/:id/reauthorize`, then the same complete route) runs
  `replaceMailboxCredential`: unlocked sanity read of the item → `ensureMailAccountSyncState` → lock sync state
  row → lock Mailboxes item → re-check on locked rows. The **sync mode** (not the user-owned `provider`
  property) must match the state's provider (`gmail_api`↔`gmail`, `graph_api`↔`outlook`). A different stored
  account address is 400 `mail_reauth_wrong_account`. It replaces the token, enqueues a sync, and does not write
  `syncStatus` or the watch address.
- After commit the route awaits `mailLiveSync.restartAccount(mailboxItemId)` (not `runAfterCommit`); a failed
  restart is a 500 although the token was replaced.

### OAuth token refresh

- `refreshAndPersistAccessToken` (`mail/mailOAuthAccess.ts`) is the one place where a provider HTTP call runs
  inside a transaction: tenant-scoped READ COMMITTED, credential row `FOR UPDATE` before decryption, held
  through exchange, replacement and commit, so a rotating refresh token is presented once.
- Bounds: request incl. body 15 s, body ≤ 64 KiB (`mail/oauthTokenExchange.ts`); transaction-local
  `lock_timeout` 30 s and `statement_timeout` 60 s (a stricter existing setting is kept).
- The access token is returned only after commit and is never persisted or cached. No automatic replay on
  timeout, rollback or ambiguous commit. Provider 400/401 maps to reauthorization; nothing else does.

## Sync

### Sync pass and the mailbox sync guard

- A pass is one run of `mailAccountSync` (`handleSyncMailAccountTask` in `mail/mailSyncJob.ts`). Reads of
  mailbox, state and credential happen first. A Gmail or Graph pass then reconciles in one transaction that also
  talks to the provider (existing, accepted cost; do not add new network work there).
- One pass per mailbox runs at a time, in every sync mode. Every trigger (IMAP IDLE, Gmail and Graph push, the
  sweep, flag and move write-back, the Mail switch, a sign-in) enqueues `mailAccountSync` under the job key
  `mail-account-sync:<mailbox>`; graphile-worker folds a repeat enqueue into a job that waits but starts a new job
  beside one that runs, so the job key alone does not serialize passes. Before its credential read, a job claims the
  pass lease on the sync state row (`pass_lease_token`, `pass_lease_expires_at`; `claimMailSyncPass` locks the row).
  When another pass holds an unexpired lease the job sets `pass_rerun_requested` and ends without a provider call.
  A Gmail or Graph pass keeps the row locked for its whole transaction, so the claim waits for the row lock at most
  `MAILBOX_SYNC_PASS_WAIT_MS` (a transaction-local `lock_timeout`); then it throws `MailboxSyncBusyError` and the job
  is skipped like one that finds the mailbox sync guard held. Only a job holding the lease records a failure: one
  that fails before it holds the lease writes no error, status, problem or notification and rethrows for
  graphile-worker's retry.
  `enterSyncPass` renews the lease in each write transaction, taking it again only while no live pass holds it, and
  ends the pass when another one does. On every way out of the pass one transaction releases the lease and, when a
  rerun was requested, enqueues exactly one follow-up pass. A holder that died blocks its mailbox for at most
  `MAIL_SYNC_PASS_LEASE_MS` (5 minutes); a failed release is logged and left to that expiry.
- An IMAP pass (`reconcileImapAccount` in `mail/imapReconcile.ts`) never talks to the provider inside a
  transaction. The folder list, each folder's selection, new messages, changed flags, vanished UIDs and every
  attachment's bytes (spooled to a temp file, `mail/imapAttachmentSpool.ts`) are fetched with no transaction
  open and no guard held; the writes then run in short transactions: a prepare transaction (Folder items, each
  folder's sync state), one transaction per folder batch, one for the flag write-back confirmations (the IMAP
  `STORE`s run before it, outside any transaction) and a final one (account activity, the next pass, `ok`
  status, problem resolved). Each starts with `enterSyncPass` and then takes the mail-thread guard. A folder
  batch locks its `mail_folder_sync_state` row and writes only while it is still the state its fetch started
  from; if another pass moved the folder on meanwhile it writes nothing and ends the pass incomplete, so a
  cursor never moves back. A failed batch deletes the attachment bytes it wrote; committed batches keep theirs.
- On a CONDSTORE server the folder list carries each folder's STATUS (UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ,
  MESSAGES), inline where the server offers LIST-STATUS and otherwise one STATUS per folder. A folder whose four
  values equal its `mail_folder_sync_state` (`message_count` included) is skipped: no SELECT, no fetch, no write
  transaction. A changed folder is selected once (`ImapFlowMailClient` reuses the selection for its fetches and
  STOREs); the new-UID search runs only when UIDNEXT passed the cursor, the flag fetch only when HIGHESTMODSEQ moved
  (always without CONDSTORE), and the vanished check only when UIDNEXT or the message count differs from the stored
  ones. The folder list is fetched on every pass: it is how an added or removed folder shows, and it brings the
  STATUS data in the same round trip.
- Deleted messages. Every IMAP connection is opened with imapflow's `qresync: true`, which ENABLEs QRESYNC where the
  server advertises it; `ImapFlowMailClient` decides by the enabled set. Under QRESYNC the flag fetch and the
  vanished check are one `UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE m VANISHED)` (`fetchChangesSince`), whose
  `VANISHED (EARLIER)` names the expunged UIDs. Whether those (or, without QRESYNC, none) are every UID that left is
  decided by the message count: the stored count, less the reported vanished UIDs below the stored UIDNEXT, plus the
  new UIDs at or above it, must equal the selected EXISTS. Only when it does not (or after a UIDVALIDITY change, a
  partial batch or with no stored count) does the pass list every UID (`UID SEARCH ALL`) and diff it against the
  known ones. UIDs only grow, so the count never hides a removal; after a complete pass a delivery alone sends no full
  UID list on any server, and no periodic full rescan is run. The IDLE connection signals on EXPUNGE and VANISHED like on EXISTS.
- A vanished UID removes that folder's Emails–Folders edge and, in the same batch transaction, marks the Email's meta
  row (`mail_message_meta.folder_copy_removed_at`, `markMailMessageFolderCopyRemoved`). In the pass's final
  transaction every marked Emails item of the mailbox (marked by this pass or by an earlier one that ended before its
  final transaction) that has no folder edge left (and no unsettled or protected move) is trashed as the
  system writer and loses its meta row through `deleteMailMessageMetaOfRemovedItem` (a thread no other message names
  goes too), as the Mail-off removal does, so it leaves every thread count and a re-delivery is ingested anew. The
  decision waits for the final transaction because another client's move shows as the target folder's new UID,
  ingested onto the same item by Message-ID, and the source folder's vanished UID; both are seen in one pass, so a
  move keeps its item and its mark is cleared. A marked Email with a move in flight keeps its mark for a later pass. A target UID left beyond the pass's budget makes the move a removal and a new item in the
  next pass. The standalone `reconcileImapFolder` removes in its own write transaction.
- An IMAP pass ingests at most `IMAP_NEW_MESSAGES_PER_PASS` new messages across the account's folders, the
  inbox first, lowest UIDs first. A folder left partial records its `uidnext` after the last ingested UID. An
  unfinished pass requests a rerun of itself in its final transaction, leaves the account due at once and keeps
  `initial_sync_completed_at` unset, so the backfill of a large mailbox is many passes of small batches.
- The mailbox sync guard `lockMailboxSync` (`mail/mailboxSyncGuard.ts`) is a transaction advisory lock on
  `mailbox-sync:v1:<tenant>:<mailbox>`. It requires a tenant scope and a READ COMMITTED transaction of that
  tenant. Optional `maxWaitMs` bounds the wait with a transaction-local `lock_timeout` restored right after
  grant; a timeout throws `MailboxSyncBusyError` (409 `mailbox_sync_busy`).
- In a pass, `enterSyncPass` takes the guard as the first statement of each write transaction (every
  transaction of an IMAP pass), then re-reads the Mailboxes item and sync state row; a trashed/missing item, a
  missing row or a paused row (Mail off) ends the pass with no further provider call and no further write. A
  removal or the Mail switch therefore waits for a pass's transaction, not for its provider calls, and an IMAP
  pass it overtakes ends at its next transaction. The pass waits for the guard at most
  `MAILBOX_SYNC_PASS_WAIT_MS`; when another pass or a removal still holds it, the pass is skipped and records
  nothing (no failure, status, problem or notification); the sweep re-enqueues an account that is still due.
- A pass with no stored credential fails with `MailReauthorizationRequiredError` (failure kind `reauthorization`,
  `syncStatus` `needsReauthorization`), whatever the status it read: only the user can store one again.
- The sweep (`listAccountsDueForSync`) leaves out an account whose last failure kind is `reauthorization`; the
  sign-in again (OAuth reauthorization or the password route) queues its next pass.
- `Mailboxes.syncStatus` (`owner: system`) has two writers: the sync job, and the mailbox removal (value
  `needsReauthorization` only, in the transaction that deletes the credential).

### Live sync root and hosted lifecycles

- `mail/mailLiveSyncRoot.ts` (`createMailLiveSyncRoot`) decides which accounts a process hosts (IMAP IDLE,
  Gmail watch, Graph subscription lifecycles), discovering live Mailboxes per active tenant in page
  transactions.
- Discovery takes no sync guard and never waits: for an account without a sync state row it seeds one only
  after `SELECT … FOR SHARE SKIP LOCKED` on the live Mailboxes item (`ensureMailAccountSyncStateOfLiveMailbox`).
  A skipped account is left out of the pass silently, as is a paused one (Mail off); a hosted account left out
  is stopped by the pass.
- `restartAccount(mailboxItemId)` stops and re-hosts one entry, running in the root's captured async context
  inside `runAsSystem("mail:liveSync")`; the tenant comes from the recorded entry, never from the caller, and a
  caller in a tenant scope only reaches its own tenant's entries. The root must be created outside any scope.
- `stopMailbox(tenantId, mailboxItemId)` waits for in-flight discovery passes and restarts, then stops the
  entry once. Routes reach the root through `createMailLiveSyncControl`
  (`services/semprec-api/src/mailLiveSyncControl.ts`), bound before the server listens; unbound calls refuse
  with `CustomRouteConfigurationError`; `startMailbox` always refuses.
- The hosted IMAP lifecycle owns its discovery/startup task: policy refusals and transient errors go into the
  bounded backoff, while `MailReauthorizationRequiredError` (the composition root's `getCredential` throws it when no
  credential is stored) ends the discovery after one report until `restartAccount` hosts a new lifecycle; stop cancels waits and joins all owned work before pool shutdown. IDLE logout grace is 10 s,
  then public `close()`; work that has not settled keeps stop pending (it is never abandoned as "done").
- The Gmail Pub/Sub dispatcher (`createGmailPubSubDispatcher`, `mail/gmailWatchLifecycle.ts`) routes each
  notification with `route_gmail_address`, enqueues `mailAccountSync` per target tenant, and acknowledges only
  after every hand-off.
- `semprec-api` shutdown order (`services/semprec-api/src/shutdown.ts`): listener close → sync server close →
  HTTP drain → `gmailPubSubDispatcher.stop()` → `mailLiveSync.stop()` → `queueRuntime.stop()` → `pool.end()`.
  A future long-lived outbound loop that enqueues work stops after the drain, before what it would race.

### Provider moves

- A user move records a desire in `mail_message_move_sync_state` (`mail/mailMessageMoveSyncStore.ts`,
  `recordDesiredMailMessageMove`); sync executes it in a move phase **before** the reconcile transaction
  (`mail/mailMessageMoveSync.ts`). Independently callable reconcilers only observe move state.
- Each step is claimed atomically in a short guarded transaction (operation token, monotonic desired revision,
  captured revision, durable phase, bounded validated evidence) and committed before dispatch. Only the
  claiming token records the outcome. The provider call runs outside every transaction, with the shared IMAP
  connection limiter, under a 30 s elapsed deadline per preparation/step.
- OAuth tokens are acquired before the claim into a private one-use command; a lost claim discards it.
- Unknown acknowledgement or owner death leaves the operation in-flight/uncertain; nothing (lease, timer, new
  desire) clears it automatically and no command is blindly repeated. IMAP identity includes UIDVALIDITY and
  needs COPYUID; a Graph old-id 404 is not proof of a move.
- A pass reads a baseline of all move rows at start and suppresses provider observations for rows pending,
  in flight or changed since the baseline.
- `keepsEarlierMoveSource` is the one rule deciding whether a new desire keeps the earlier source evidence;
  both the writer and `hasPreservedMailMoveSource` use it.

## Threads

### Mail-thread mutation guard

- `lockMailThreadMutation` (`mail/mailThreadMutationGuard.ts`): transaction advisory lock on
  `mail-thread-mutation:v1:<tenant>`; requires a tenant scope and a READ COMMITTED transaction.
- It is taken first, before membership reads, thread resolution, metadata or item locks, by: the resolver,
  ingest (before its existing-message read and savepoint), the IMAP/Gmail/Graph reconcilers (Gmail before its
  folder-state guard), SMTP failed-claim cleanup, merges, thread actions, thread-task writes, the
  `mail.thread.proposeTask` tool and the mail purge hook.
- It serializes all thread decisions of a tenant across mailboxes and inherits the reconcile transaction's
  lifetime, provider calls included.
- Only writers that hold several Emails items in one transaction take it. Single-item writers (generic item
  PATCH, draft writes, person linking) do not.

### Merges and Threads relations

- Each `mail_threads` row is bound to a Threads item (`item_id`, internal). `reassignThread`
  (`mail/mailMessageMetaStore.ts`) merges: guard → recheck rows → lock both Threads items in UUID order →
  sorted definition reservations → structural transfer (`transferMailThreadRelationsWithClient`, internal
  command in `chokePoint/relationOps.ts`) → soft-delete loser via `itemDeleteWithClient` as system writer →
  move messages, repoint aliases, delete loser row. Any failure rolls back the whole merge.
- Structural transfer only swaps the losing Threads endpoint for the winner; it may keep edges to trashed
  counterparts. Delete-then-insert so cardinality is checked on the final value; hooks still run.
- Precedence for `Threads.project`/`company` (`mail/threadMergePrecedence.ts`): own value beats inherited; among
  equals the older `mail_threads.created_at` wins; the link follows the adopted value.
- The Threads domain hook (`mail/threadValueEdges.ts`) reserves every Threads endpoint of any relation mutation
  (UUID order, `FOR UPDATE` or the value-link NOWAIT wrapper), rechecks liveness, and enforces at most one
  project/company per thread. All production writes incident on Threads go through these owners.
- Edges of `Threads.company`/`project` publish a `mailThread` invalidation after commit.
- Failed-SMTP-claim cleanup removes an emptied thread by soft-deleting its Threads item, then the row.

### Thread actions

- Every thread action (`mail/mailThreadActions.ts`, routes in `mail/mailThreadRoutes.ts`) starts with
  `resolveMailThreadForAction`, which takes the guard before resolving the thread and before any item lock.
- Moves (archive, trash, restore, any later purpose) go only through `applyMailThreadMoves`: plan targets per
  mailbox → resolve every copy's source before any write (409 `mail_move_source_unverified` if unaddressable)
  → per copy record the desire first, then replace its `Emails.folder` edges with one UID-less edge → enqueue
  one account sync per mailbox → one `mailThread` invalidation after commit.
- Provider write-back of flags is queued by the Emails flag hook; thread actions make no provider call.
- A copy is **received** (`received` in `mailThreadCopyCtes`) when it is in an Inbox or Junk folder, when it has a copy
  of its own beside a Sent copy whose edge carries a UID, or when its sender is no mailbox address of the tenant and it
  is in no Sent folder. Mail to oneself is therefore received; only its Sent copy is the user's own. The list's and the
  summary's `unread` and the actions' incoming copies (Drafts copies excluded) read it.
- `read: false` and `flagged: true` on a thread without a received message are 409 `mail_thread_no_received_message`
  and write nothing; `read: true` and `flagged: false` with nothing to change are 200.
- An IMAP server keeps mail to oneself twice (Sent and where it was delivered) and both converge on one Emails item. An
  IMAP move of an item that is also in another folder takes the one provider message outside Sent and keeps the Sent
  copy's edge with its UID: archive and trash move the delivered copy, restore brings it back to the Inbox. A flag
  observation of that Sent copy is ignored while the item has a copy with a UID elsewhere
  (`applyObservedMailMessageFlags`), so the item's `read`/`flagged` follow the delivered copy.
- An archive or trash desire records in `mail_message_move_sync_state.restore_purpose` whether the copy left an Inbox
  or a Sent folder (an earlier record stays when it left neither); restore returns the copy there, and only a copy
  without a record goes by received (Inbox) or own (Sent).

### Inherited values

- `threadCompanyFromSender` / `threadProjectFromCompany` (`mail/threadLinkRules.ts`) are resolver link rules
  (`ModuleResolverLinkRuleDescriptor`): company from the first inbound message's sender domain matched against
  `Companies.web`; project = the company's single `inProgress`/`longTerm` project. Ambiguity yields nothing.
- `createThreadTask` (`mail/threadTasks.ts`) is the only writer of a task made from a thread: Tasks item,
  `Threads.tasks` edge, link `taskProjectFromThread`, and an `on` link of rule key `mailThreadTaskPeople` with
  the conversation's people (live People linked as sender/recipient, minus the tenant's own addresses).
  A relink of the people link is refused (`value_link_conflict`).
- A nameless task is named by gateway operation `mail_thread_task_name`: snapshot at REPEATABLE READ, model
  call outside, write under the guard with the live messages locked `FOR SHARE`; changed set → 409 `conflict`.
- `mailSyncThreadTaskPeople` (`mail/threadTaskPeople.ts`) adds people who join later: queued by an edge-created
  hook on `Emails.senderPeople`/`recipientsPeople`, key `mailSyncThreadTaskPeople:<tenant>:<thread>:<person>`;
  it only adds, and only while the task's link is `on`, read after locking task row then link row.
- Attachments: `Threads.attachments` (system, `emails` process) is written at ingest; rule
  `fileProjectFromThread` gives Files the thread's project. A merge calls `repointThreadAttachmentLinks` before
  moving edges, else the generic move would delete the `on` links.
- Event attachments: rule `fileProjectsFromEvents` (`Events.project` → `Files.projects` via `Files.events`).
  `eventAttachmentLinkReleaseEdgeChangedHook` (`blobs/eventAttachmentLinkRelease.ts`) ends the file's projects
  and companies links when its last Event source is detached; it must stay registered **directly before**
  `linkRuleEdgeHook` in `domainWriteHooks.ts`.
- No inherited value is backfilled.

### Thread refs

- A `mailThread` Semp ref stores the id as given (thread id or alias); `mail/mailThreadRef.ts` resolves
  aliases, label (earliest live message subject, else `subject_hint`), state (`trashed` when no live copy or all
  live copies only in Trash folders; `purged` for unknown ids) and database key (always null) at read time,
  one statement per batch.
- A thread's subject, wherever it is shown (thread list and detail, ref label, global search), is its earliest
  live message's: a reply or a bounce threaded later does not rename the conversation. Order, `lastMessageAt`,
  `lastSender` and the preview follow the newest message.

## People linking

- `person_email_index` maps addresses to People. The producer enqueues `mail-link-person-emails:<personId>`
  only for addresses actually inserted; the payload is a wake-up hint. The handler (`mail/linkPersonEmailsJob.ts`)
  reconciles currently indexed rows page by page, holding the index rows `FOR SHARE` through the page's writes.
- `linkEmailEnvelopeToPeople` (`mail/personLinkingActions.ts`) locks the Emails item `FOR UPDATE` before
  reading sender edges. Any existing `senderPeople` edge prevents another; historical edges are never
  replaced or removed when an address changes owner. Recipients stay many-valued and idempotent.

## Drafts and sending

### Drafts

- A Semprec draft is an Emails item in Drafts plus a `mail_drafts` row (`mail/draft.ts`, `mail/mailDraftsStore.ts`).
  A mailbox for which neither the connect nor a sync pass found a Drafts folder refuses a new draft with 409
  `mail_drafts_folder_missing` (`details.mailboxId`) and writes nothing.
- Every writer of an existing draft uses `lockUnsentDraft`: Emails item `FOR UPDATE`, then `mail_drafts` row.
  Refusals: 404 no live item; 409 `mail_draft_not_editable` (no row); 409 `mail_draft_already_sent` (`sent_at`
  set **or** a send claim exists); 409 `version_conflict` on `ifVersion` mismatch. Draft writers take no
  thread guard.
- `discardEmailDraft` trashes the item and deletes the row; a restored discarded draft is not editable.
- `attachFileToDraft` copies a Files item another email holds (same blob) instead of moving it; repeats are
  no-ops. Discard trashes attached files created after the draft that have no edge to any other item
  (`deleteFilesOfDiscardedDraft`). Lock order: Emails item → `mail_drafts` row → Files item.

### Sending

- `sendDraftEmail` (`mail/send.ts`, `mail/mailDraftSend.ts`): for a user, an account with Mail off is refused
  with 409 `mail_disabled` ahead of the reauthorization, sender and Sent-folder checks, and again in the claim
  transaction, which first reads the sync state row `FOR SHARE` (a switch that commits later waits for the
  claim). An approved agent send refused this way ends as `callFailed` and sends nothing. Claim transaction (locks item then row, refuses
  trashed/sent, runs the optional `beforeClaim` guard, writes the `mail_message_meta` claim and threads the
  message) → provider send outside any transaction → finalization transaction (`sent_at`, move to Sent,
  people linking). A failed send deletes its claim in its own transaction; a failed finalization keeps it.
  No automatic send retry.
- Transports: SMTP (`createSmtpMailTransport`), Gmail and Graph REST clients. Once the provider accepted the
  message, close/Sent-copy/response-cleanup failures keep the accepted result. The send stays synchronous: the
  IMAP connection for an SMTP account's Sent copy opens while SMTP submits, the APPEND runs only after acceptance,
  and a refused submission closes that connection unused before the refusal is answered. A Graph failure before
  acceptance best-effort deletes the owned draft.
- Every mail-send failure log uses `describeMailFailure` (`mail/describeMailFailure.ts`: class name and SMTP
  codes) plus local ids, never the error object, because errors carry recipient addresses.

### Agent sends and MCP mail tools

- An `ai_agent` actor never sends, whatever `emailSendAutonomous` says. `sendDraftEmail` instead calls
  `requestMailSendApproval` (`mail/mailSendApproval.ts`): an `outbound` request of tool `mail.draft.send`,
  payload built from the locked stored draft with `draftHash` (SHA-256 of canonical recipients, subject, body,
  attachments). The description (`approval.emailSend`) carries only mailbox name and recipient count.
  At most one pending request per draft (ordered by the item lock); deciding one supersedes the others.
- `executeClaimedMailSendApproval` re-reads and re-hashes, then sends with a `user` actor; `beforeClaim`
  re-hashes under the claim locks. Mismatch → `conflict` (`sourceChanged`); other failure → `callFailed`, not
  retried. At most once.
- Tool `mail.draft.send` is declared `approval: "none"` but its handler only files the request; the request
  is the gate.
- MCP: tools opt in with `mcp: { humanHandlerExport }` (`mail.thread.get`, `mail.draft.create`,
  `mail.draft.update`, `mail.draft.send`). A run credential sees a tool only if it lists the module
  capability and the run's project holds it. A human session runs the human handler as the user, writing as
  `writerKind: "agent"` on behalf of the user with the external-client marker; its `mail.draft.send` sends
  directly.
- `mail.thread.proposeTask` (capability `mail.taskProposal`, approval none) only creates a `mailThread` card.

## Mailbox removal, restore and purge

- Only `removeMailbox` (`mail/mailboxRemoval.ts`, `DELETE /api/mail/mailboxes/:id`) removes a mailbox.
  `mailboxDeleteHook` refuses a `user`/`agent` trash of a system Mailboxes item (403 `forbidden`); the
  matching `mailboxDeleteApprovalGuard` (`registerItemDeleteApprovalGuard`) refuses an agent's `item.delete`
  before it is queued. A delete hook that refuses by rule must register such a guard.
- Removal is one READ COMMITTED transaction: sync guard (≤ 15 s, `MAILBOX_REMOVAL_SYNC_WAIT_MS`) → calendar
  sync guard (same bound) → sync state row → Mailboxes item → read cleanup input into memory
  (`readMailboxRemovalCleanupInput`) → `syncStatus = needsReauthorization` → trash item as system writer →
  delete credential, sync state, folder sync states, server settings → enqueue `mailboxRemoval` → stop the
  calendar sync (`stopCalendarAccountSync`). Deletes matching no row are fine.
- `mailboxRemoval` job (`mail/mailboxRemovalJob.ts`, lane `mailbox-removal:<tenant>`): chunks of ≤ 100 rows,
  Emails then Folders (`MAILBOX_REMOVAL_MEMBERS_CTE_SQL`), each chunk locks the Mailboxes item `FOR SHARE`
  (`lockItemTrashEpoch`) and trashes with `deletedAtExact` = the mailbox's `deleted_at`; a live mailbox ends it.
- The same task with `purpose: "mailOff"` (key `mailbox-mail-off-<id>`, same lane) removes the mail of a live
  account with Mail off: each chunk takes the paused sync state row `FOR SHARE`, the mail-thread guard and the live
  Mailboxes item `FOR SHARE`, trashes with `deletedAtExact` = `sync_paused_at`, and deletes each trashed
  Email's meta row with a thread no other message names (`deleteMailMessageMetaOfRemovedItem`: Threads item
  trashed, `mail_threads` row deleted), so a later sync ingests the mail anew. An account no longer paused, or
  a trashed or gone mailbox, ends it. A trashed Email restored by hand comes back without meta row.
- After commit `cleanUpRemovedMailbox` (`mail/mailboxRemovalProviderCleanup.ts`) runs awaited, best effort, from
  in-memory values: `liveSyncStop` → Gmail watch stop / Graph subscription delete → Google token revocation.
  Provider follows the sync mode, not `provider`. Google calls happen only when `getGmailAccountUse` says the
  mailbox is the `sole` recorder of the account. Microsoft tokens are not revoked. Steps are 10 s each, logged
  with a fixed classification only; nothing is retried or persisted.
- Restore: `mailboxItemRestoreHook` (`mail/mailboxRestoreHook.ts`) first refuses (409
  `provider_account_already_connected`, rolling the restore back) a mailbox one of whose addresses another live
  mailbox lists or records (`mailboxHoldsAnyAddress`), then seeds a default sync state if none
  (unlocked read + `ON CONFLICT DO NOTHING`, never waits on an existing row), and restores the Folders and Emails
  of the exact trash epoch in the same transaction. It takes no sync guard and does not write `syncStatus`.
- Purge: `mailItemPurgeHook` (`mail/mailPurgeHook.ts`) acts on system Emails/Mailboxes items. Emails: the meta
  row (and an emptied thread: soft-delete its Threads item, delete the row); blobs and Files stay. Mailboxes:
  folder sync states of folders without a `Folders.mailbox` edge. The hook takes the thread guard after the
  purge's own locks (fixed by the registry). Attachments, flag sync state, credential, sync state and server
  settings go with the item through their foreign keys (data-model-and-writes.md, _Storage_).

## Provider failure privacy

Applies to SMTP send, IMAP connect and later IMAP calls/streams, Gmail/Graph sync reads and attachment
streams, Gmail/Graph send and upload, provider moves, hosted IDLE, credential verification and removal cleanup.

- Inside the operation owner, keep the original primary and secondary failure values (including `undefined`)
  until settlement and cleanup finish; cleanup never replaces the primary.
- At the client boundary an unknown provider failure becomes a fresh fixed generic `Error` with no cause,
  properties or aggregate members. Never infer auth/unreachable/recipient refusal from unknown errors.
  Known classifications and genuine HTTP status branches (Gmail 404/history invalidation, Graph 404/410) stay.
- Diagnostics use fixed stage/category tags, numeric HTTP status and trusted local ids only: no raw error,
  name/code, host, folder path, address, token, header, URL (preauthenticated upload URLs are credentials),
  cursor, provider id, server text or message bytes.
- Catches wrap provider operations only; SQL, choke-point writes, ingest, blob storage and `getAccessToken`
  stay outside and keep their error identity. No outer job-level sanitizer.
- Graph well-known-folder discovery treats only a real `GraphApiError` 404 as an absent folder.

## Inbox

### Capture, uploads and attachments

- `POST /api/blobs` (`ingestUploadedBlob`) accepts only Inbox attachment types (PDF, JPEG, PNG, XLSX, DOCX,
  M4A, MP3) plus HEIC, decided from leading bytes; anything else is 415 `unsupported_media_type` with bytes
  removed. A blob's attachment type is `effectiveBlobMimeTypeSql` (verified detected type, else stored).
- A capture (`POST /api/inbox/items`, `inbox/captureAttachments.ts`) locks its blobs `FOR KEY SHARE` in id order
  (`lockBlobsForReference`) before inserting `inbox_attachments`.
- `inbox_attachments` is written only through `inbox/inboxAttachmentsStore.ts`. Every attachment writer takes the
  source Inbox item lock (`lockInboxSource`, `inbox/inboxSourceGuard.ts`) first, then the attachment row.

### Attachment facts, photos and voice notes

- The capture enqueues `inboxAttachmentMetadata` (key `inbox-attachment-metadata:<attachmentId>`), run only in
  `semprec-transcribe` on its own one-slot runner (ffmpeg confinement). It probes dimensions, a 128 px preview and
  a ≤ 1568 px reduced copy (images, `-max_pixels`), duration, `recordedAt` and `audioKind` (`voiceNote` below
  `INBOX_RECORDING_MIN_SECONDS` = 120, else `recording`). Unreadable files get `metadata.error = "mediaUnreadable"`.
- `recordInboxAttachmentMetadata` writes `metadata`, `thumbnail_blob_id`, `reduced_blob_id` once (source lock →
  row lock → `metadata IS NULL`), then fires the item's `onItemEvent` heartbeats in the same transaction.
  Derived blobs are counted references; bytes are written before the transaction under fresh keys.
- Photos: the API proposal computation reads up to four reduced images via `extractAttachmentDocument`
  (operation `inbox_attachment_extraction`) and caches the answer once in `inbox_attachments.extraction`
  (`recordInboxAttachmentExtraction`). While an image lacks metadata the tick does nothing
  (`hasAttachmentAwaitingMetadata`).
- Voice notes: `inboxVoiceNoteTranscribe` (key `inbox-voice-note:<item>`, replace mode, transcribe runtime)
  writes `Inbox.transcribedText`, a system property owned by the transcribe process; the person-owned `text` is
  never written. The write locks the item and writes only if the set of voice notes is unchanged, else fails
  for retry.

### Tick and the source lock protocol

- `semprec.tick` (`inbox/inboxTickAction.ts`) reads at REPEATABLE READ (`withTickTransaction`), calls the model
  outside, and writes at READ COMMITTED (`withTickWriteTransaction`): lock source `FOR UPDATE`, re-read
  properties/type edge/attachment hashes fresh, skip on fingerprint mismatch, hold the source to commit.
- Source-input writers (attachments, the Inbox type edge hooks, `Processing proposals.sourceInbox` association
  hooks) take the same source lock before mutating. Multi-source operations lock sources in id order.
- Rules that keep the confirm path (card first, then source) deadlock-free:
  - a holder of the source never waits for a card: it uses `FOR UPDATE NOWAIT` and treats busy as a skip
    (tick) or 409 `version_conflict` (thread send, type change), mapping only SQLSTATE 55P03 after a savepoint;
  - the linked type row is taken `FOR SHARE NOWAIT`; busy is a skip;
  - a live `confirmed`/`rejected` current card makes type changes and Inbox thread sends refuse with 409
    `proposal_locked` (`inbox/inboxTypeCardReservation.ts`, `semp`/`sempThreads` send guard);
  - an item-thread agent tool locks its card first, then reads the `sourceInbox` edge `FOR SHARE`, never the
    source, and requires `ifVersion`;
  - file-from-attachment confirm takes the source lock before the blob lock.
- Inbox item-thread sends resolve the current cards through `sourceInbox` (stored `subject_proposal_id` and a
  client `proposalId` are hints) in the order source → cards (NOWAIT) → thread.

### Proposal context

- `readProposalWorkspaceContext` (via `services/semprec-api/src/proposalContext.ts`) reads as the tick's
  Semprec project; databases from `listUnreadableDatabaseIds` contribute nothing (no empty group or count).
- Only five built-in kinds, ≤ 20 entries each (`CONTEXT_LIMIT_PER_KIND`), texts cut at 100 chars: projects
  `id,name,status,areaId`; areas `id,name`; people `id,name,relationship`; companies
  `id,name,registrationNumber`; events `id,name,type,date` (capture date −1 … +14 days).
- Plus capture facts, `text` or `transcribedText`, and for recompute the card's previous state. Budget
  900 KiB (`REQUEST_BUDGET_BYTES`); workspace entries are dropped events → companies → people → areas →
  projects; item text and facts are never cut.
- Returned ids must be members of the request for the relation's exact target database; others are removed,
  and an update/link to a non-member takes the `needsClarification` path.

### Cards: kinds and producers

- `kind: inbox` cards: `semprec.tick` produces the primary card of a source. The only other producer is
  `splitInboxSourceWithClient` (`inbox/proposalSplit.ts`) for siblings: primary locked `FOR UPDATE`, not decided,
  ≤ 10 cards total (`MAX_SPLIT_CARDS`); siblings carry `splitFromProposalId` and are ignored by the tick.
- Recording cards: an `inbox` card with `entityKind: "transcription"` (derived kind `recording`) is built by the
  tick without a model call for the first `recording` audio attachment. Its confirm moves the attachment into
  Files and calls `recordRecordingIntake` with the card's parameters (`inbox/recordingCardConfirm.ts`);
  `followUp: transcriptionQueued` only when both jobs were read back.
- `kind: mailThread`: produced only by the mail module through `proposeThreadTask`
  (`mail/threadTaskProposals.ts`) as a system write with a `sourceThread` edge; under the thread guard and the
  Threads item lock it returns an existing open card of the same (case-folded) name. Envelope: Tasks, `name`
  (≤ 500) and optional `date` only. Confirm locks the Threads item and calls `createThreadTask` as a user write.
- A card created by any other writer is an ownership violation.

### Proposal steps

- Step ops: `create`, `update`, `link`, `fileFromAttachment` (`inbox/proposalEnvelope.ts`).
- `fileFromAttachment` (never primary): properties exactly `attachmentId`, `name`, optional `date`. Confirm
  checks the attachment belongs to the card's `sourceInbox` item, locks the blob, reuses a live Files item over
  the same blob or creates one (`filesTypeForMimeType`), then deletes the attachment row (409 if already gone).
  A created item gets an `inbox` origin, which the Files transcription trigger skips.

### Editor schemas

- A card editor schema is declared in the manifest field `editorSchemas` of the module owning the target
  database, keyed by base kind; duplicates fail `ModuleRegistry.loadModule`. System databases' schemas are in
  `seed/systemDatabasesEditorSchemas.ts`; the schema shape is checked strictly in
  `packages/module-registry/src/manifest.ts`.
- Field keys are properties, relations or pseudo keys: `allDay`, `due`, `followupTask`, `followDate`,
  `credential`, `transport`, `access`, `mcpProjects`, `lang`, `speakers`, `recordedAt`, `day`, `page`,
  `placement`, `heading`, `area`, `markdown`. Renaming any is a client contract change.
- Rules (`inbox/proposalEditorRules.ts`) read effective values (step properties overlaid by `userOverrides`).
  Missing visible required fields fail confirm (`ValidationError`) and are warnings on edit; hidden fields are
  neither validated nor written. Pseudo values live in `userOverrides` and are never written to items.

## Lock orders to keep

- Sync pass: mailbox sync guard → sync state row (lease renewal) → mail-thread guard → Gmail folder-state guard →
  folder/item rows.
- Pass lease claim and release: the sync state row alone, then (release only) the follow-up job's insert.
- Sync state row → Mailboxes item (sync job failure/activity writes, removal, reauthorization).
- Service switch / removal: mailbox sync guard (Mail) → calendar sync guard (Calendars) → sync state row (Mail)
  → Mailboxes item. Mail-off chunk: sync state row (share) → mail-thread guard → Mailboxes item (share) → member
  rows.
- Send claim: sync state row (share) → Emails item → `mail_drafts` row → mail-thread guard.
- Merge: thread guard → both Threads items (UUID order) → definition reservations (id order) → edges.
- Draft writers: Emails item → `mail_drafts` row → Files item.
- Inbox: source item → attachment row; source → blob; card holders never wait for the source and source
  holders never wait for a card.
- Value-link evaluation: target item row → its link row.

## Related rules

- `fatal` is written only by the shared fatal handlers and by a service's `registerShutdownSignals` when
  `shutdown()` rejects, immediately before `process.exit(1)`; every other failure logs at `error` or below
  (`backend/packages/shared/src/logger.ts`).
- Semp chat turns (`sempMessage`) run on `tenantLane("semp-chat")` (`semp/sempMessageQueue.ts`), FIFO per tenant,
  with `maxAttempts: 1` and `jobKeyMode: "unsafe_dedupe"`; outside a tenant scope enqueueing throws.
