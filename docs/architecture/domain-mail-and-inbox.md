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
    never-connected mailbox) and reset the account to never synced (Gmail history id and listing cursor, Graph
    delta link and delta round in progress, initial-sync mark, next expected activity and failure record
    cleared); delete the folder sync states; resolve the mailbox's Semp problem as `sourceDeleted`; enqueue the
    mail-off `mailboxRemoval` job. After the commit the live sync is stopped through the stop `bindMailboxServiceLiveSyncStop` bound
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
- `openImapFlow()` waits for a login admission of the server host (`admitLogin` of the shared IMAP connection
  limiter, see [IMAP connection limits](#imap-connection-limits-and-kept-sync-sessions)) before it connects, so every
  sync, move, Sent APPEND and IDLE login is rate limited; the credential verifications of the connect and sign-in
  routes do not use it (they are throttled per user).
- The sync adapter and the IDLE connection factory report a failed `openImapFlow()` through one classifier,
  `classifyImapConnectFailure()`: too many sessions → `MailConnectionLimitError`; a refused LOGIN →
  `MailReauthorizationRequiredError`, unless its RFC 5530 code is a transient one (`UNAVAILABLE`, `INUSE`, `LIMIT`,
  `SERVERBUG`); unreachable stays `MailServerUnreachableError`; anything else becomes a fixed generic error. None
  keeps a cause.
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
  activity), `clearCalendarSyncCredentialRefusal` (`needsReauthorization` or `needsConsent` → `never`), enqueue
  `mailAccountSync` and, with Calendars on, `calendarAccountSync`. After the commit the route awaits
  `mailLiveSync.restartAccount`; a failed restart is logged (`mailboxItemId`, `errorName`) and the route still
  answers 200, because the replacement is committed and the queued pass reads the new password. Refusals answer 400
  with the connect's codes and change nothing. `syncStatus` is left to the queued pass.

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
  account address is 400 `mail_reauth_wrong_account`. It replaces the token and the granted scopes, clears the sync
  failure record (`clearMailSyncFailure`, as the password route does) and the calendar credential refusal
  (`clearCalendarSyncCredentialRefusal`: `needsReauthorization` or `needsConsent` → `never`), enqueues a mail sync
  and, with Calendars on, `calendarAccountSync`, and does not write `syncStatus` or the watch address.
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
  mailbox, state and credential happen first. No pass, in any sync mode, talks to the provider inside a
  transaction: every provider call runs between short write transactions, each of which starts with
  `enterSyncPass` and then takes the mail-thread guard (`inPassTransaction`, `mail/mailSyncPass.ts`). A failed
  batch deletes the attachment bytes it wrote (`withBatchStorage`); committed batches keep theirs.
- One pass per mailbox runs at a time, in every sync mode. Every trigger (IMAP IDLE, Gmail and Graph push, the
  sweep, flag and move write-back, the Mail switch, a sign-in) enqueues `mailAccountSync` under the job key
  `mail-account-sync:<mailbox>`; graphile-worker folds a repeat enqueue into a job that waits but starts a new job
  beside one that runs, so the job key alone does not serialize passes. Before its credential read, a job claims the
  pass lease on the sync state row (`pass_lease_token`, `pass_lease_expires_at`; `claimMailSyncPass` locks the row).
  When another pass holds an unexpired lease the job sets `pass_rerun_requested` and ends without a provider call.
  Each write transaction of a running pass holds the row from its lease renewal to its commit, and a removal or the
  Mail switch holds it for its own transaction, so the claim waits for the row lock at most
  `MAILBOX_SYNC_PASS_WAIT_MS` (a transaction-local `lock_timeout`); then it throws `MailboxSyncBusyError` and the job
  is skipped like one that finds the mailbox sync guard held. Only a job holding the lease records a failure: one
  that fails before it holds the lease (it has made no provider call yet) writes no error, status, backoff, problem
  or notification, is logged and rethrown, and is not retried (`maxAttempts` 1); the sweep queues the account again
  once it is due.
  `enterSyncPass` renews the lease in each write transaction, taking it again only while no live pass holds it, and
  ends the pass when another one does. On every way out of the pass one transaction releases the lease and, when a
  rerun was requested, enqueues exactly one follow-up pass. A holder that died blocks its mailbox for at most
  `MAIL_SYNC_PASS_LEASE_MS` (5 minutes); a failed release is logged and left to that expiry.
- An IMAP pass (`reconcileImapAccount` in `mail/imapReconcile.ts`) never talks to the provider inside a
  transaction. The folder list, each folder's selection, messages, changed flags, vanished UIDs, every full
  message's body parts and attachment bytes (spooled to a temp file, `mail/mailAttachmentSpool.ts`) and every index
  message's snippet are fetched with no transaction open and no guard held; the writes then run in short
  transactions: a prepare transaction (Folder items, each folder's sync state), one transaction per folder batch
  (a folder's live step, or a backfill batch of at most `IMAP_MESSAGES_PER_BATCH` = 50 messages), one for the flag
  write-back confirmations (the IMAP `STORE`s run before it, outside any transaction) and a final one (account
  activity, the next pass, `ok` status, problem resolved). Each starts with `enterSyncPass` and then takes the mail-thread guard. A folder
  batch locks its `mail_folder_sync_state` row and writes only while it still holds the cursors its fetch started
  from: a live step compares the live cursors (UIDVALIDITY, `uidnext`, HIGHESTMODSEQ, message count, `live_from_uid`)
  and keeps the stored backfill cursor, a backfill batch also compares `backfill_below_uid` and writes nothing while a
  native client holds the folder's lease. If another pass (or a client's upload) moved the folder on meanwhile it
  writes nothing and ends the pass incomplete, so a cursor never moves back. A failed batch deletes the attachment
  bytes it wrote; committed batches keep theirs.
- A Gmail pass (`reconcileGmailAccount` in `mail/gmailReconcile.ts`): the label list, then a prepare transaction
  (label Folders, the cursor read), then the live step, then the listing, then the flag write-back (pending writes
  read in one transaction, `messages.modify` outside it, confirmations in the final transaction) and the final
  transaction (account activity, the next pass, `ok` status, problem resolved). Every write transaction also takes
  the Gmail folder-state guard after the mail-thread guard, locks the sync state row and writes only while the
  stored cursor is still the one its fetch started from; otherwise it writes nothing and ends the pass incomplete.
  - Cursor (`mail_account_sync_state`): `gmail_history_id`, the start of the live step, and the listing cursor
    `gmail_listing_phase` (`full`, `index`, NULL when no listing runs) with `gmail_listing_page_token`.
  - A first pass (no history id) captures the current history id (`users.getProfile`) before anything is listed
    and stores it with the listing cursor `full`; so does the resync after a `history.list` 404, which also records
    the invalidation as `last_error`. Every later pass applies the history since the stored id first, then
    continues the listing, so new mail is never held back by a running listing.
  - Live step: `history.list` from the stored id (all its pages, ids only), the changed messages in write
    transactions of `GMAIL_MESSAGES_PER_BATCH` (50); the last one drops the edges of deleted messages and stores the
    new history id. It is not bounded by the pass budget; an interrupted step lists the same history again, and the
    messages its committed batches wrote are then known.
  - Listing: `messages.list` newest first, `maxResults` 50 (`GMAIL_LISTING_PAGE_SIZE`), one page per write
    transaction, which stores the page token of the next page; the last page of `full` moves the cursor to `index`,
    the last page of `index` ends the listing. Phase `full` searches `after:<window start>`, phase `index`
    `before:<window start + 1 s>`, the window start being `connected_at` less 90 days in epoch seconds (the
    phases may overlap by a second; a message both list is ingested once). An interrupted listing resumes at its
    stored page, and its history id is kept.
  - Fetches: a message the mailbox already holds by its Gmail id is fetched with `format=metadata` (labels and
    flags are what can change) and converges; otherwise a live-step or `full`-phase message with `format=full`, an
    `index`-phase message with `format=metadata` (`metadataHeaders`: the envelope, threading, delivery, bulk and
    Content-Type headers) and its `snippet`.
  - Budget: `GMAIL_FULL_MESSAGES_PER_PASS` (50) full and `GMAIL_INDEX_MESSAGES_PER_PASS` (500) index or known
    messages per pass, spent page by page; a pass whose listing is left unfinished is incomplete, requests a rerun
    in its final transaction, leaves the account due at once and keeps `initial_sync_completed_at` unset, which the
    pass that ends the listing sets.
- A Graph pass (`reconcileGraphAccount` in `mail/graphReconcile.ts`): the folder list, then a prepare transaction
  (Folder items, the cursor read), then the delta round page by page, then the flag write-back and the final
  transaction as for Gmail. Every write transaction locks the sync state row and writes only while the stored cursor
  is still the one its fetch started from.
  - Cursor: `graph_delta_link`, the delta link of the last completed round, and `graph_delta_next_link`, the next
    page of the round in progress. A pass continues the round at the stored next link, else starts a round at the
    delta link, else from scratch. Each page (`Prefer: odata.maxpagesize=50`, `GRAPH_DELTA_PAGE_SIZE`, `$select`
    without `body`) is written in one transaction that stores its next link; the page carrying the round's delta
    link stores it as `graph_delta_link` and clears the next link, and only then is the round complete. A
    `410 Gone`/`resyncRequired` on a stored link clears both, records the invalidation as `last_error`, and the same
    pass starts a round from scratch.
  - Per page, outside any transaction: which Message-IDs the mailbox already holds (those converge, nothing is
    fetched), and for each other message its content state by `mailContentStateOf` (`receivedDateTime` as its
    Date); a `full` one's body (`GET /messages/{id}?$select=body,bodyPreview,hasAttachments`) and, when it has
    attachments, its attachment list, the bytes spooled.
  - Budget: `GRAPH_FULL_MESSAGES_PER_PASS` (50) full and `GRAPH_INDEX_MESSAGES_PER_PASS` (500) index or known
    messages per pass, for rounds from scratch and from the delta link alike, spent page by page; a pass that ends
    its round unfinished is incomplete like a Gmail one, and `initial_sync_completed_at` is set by the pass that
    completes the first round.
- On a CONDSTORE server the folder list carries each folder's STATUS (UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ,
  MESSAGES), inline where the server offers LIST-STATUS and otherwise one STATUS per folder. A folder whose four
  values equal its `mail_folder_sync_state` (`message_count` included) skips its live step: no SELECT, no fetch, no
  write transaction. The STATUS tells nothing of the backfill, so a folder whose backfill is unfinished still runs
  its backfill step. A changed folder is selected once (`ImapFlowMailClient` reuses the selection for its fetches and
  STOREs); the new-UID search runs only when UIDNEXT passed the cursor, the flag fetch only when HIGHESTMODSEQ moved
  (always without CONDSTORE), and the vanished check only when UIDNEXT or the message count differs from the stored
  ones. The folder list is fetched on every pass: it is how an added or removed folder shows, and it brings the
  STATUS data in the same round trip.
- Deleted messages. Every IMAP connection is opened with imapflow's `qresync: true`, which ENABLEs QRESYNC where the
  server advertises it; `ImapFlowMailClient` decides by the enabled set. Under QRESYNC the flag fetch and the
  vanished check are one `UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE m VANISHED)` (`fetchChangesSince`), whose
  `VANISHED (EARLIER)` names the expunged UIDs. Whether those (or, without QRESYNC, none) are every UID that left is
  decided by the message count: the stored count, less the reported vanished UIDs below the stored UIDNEXT, plus the
  new UIDs at or above it, must equal the selected EXISTS. Only when it does not (or after a partial batch or with no
  stored count) does the pass list every UID (`UID SEARCH ALL`) and diff it against the known ones. UIDs only grow, so the count never hides a removal; after a complete pass a delivery alone sends no full
  UID list on any server, and no periodic full rescan is run. The IDLE connection signals on EXPUNGE and VANISHED like on EXISTS.
- A vanished UID removes that folder's Emails–Folders edge and, in the same batch transaction, marks the Email's meta
  row (`mail_message_meta.folder_copy_removed_at`, `markMailMessageFolderCopyRemoved`). In the pass's final
  transaction every marked Emails item of the mailbox (marked by this pass or by an earlier one that ended before its
  final transaction) that has no folder edge left (and no unsettled or protected move) is trashed as the
  system writer and loses its meta row through `deleteMailMessageMetaOfRemovedItem` (a thread no other message names
  goes too), as the Mail-off removal does, so it leaves every thread count and a re-delivery is ingested anew. The
  decision waits for the final transaction because another client's move shows as the target folder's new UID,
  ingested onto the same item by Message-ID, and the source folder's vanished UID; both are seen in one pass, so a
  move keeps its item and its mark is cleared. A marked Email with a move in flight keeps its mark for a later pass.
  A target UID left beyond the pass's budget makes the move a removal and a new item in the next pass. The
  standalone `reconcileImapFolder` removes in its own write transaction.
- IMAP cursors, per folder in `mail_folder_sync_state`. When the folder's state is established (its first pass, or
  the first after a UIDVALIDITY change, which `resetForUidvalidityChange` clears it for) the selected UIDNEXT becomes
  `live_from_uid`, the live cursor `uidnext` and `backfill_below_uid` (`NULL` for a UIDNEXT of 1). Every UID at or
  above `uidnext` is new; every UID from 1 below `backfill_below_uid` still awaits the backfill; `backfill_below_uid`
  `NULL` with `live_from_uid` set means the folder's backfill is done. The two ranges never meet: the backfill only
  covers UIDs the folder held when its state was established.
- Order of a pass. First every folder's live step, the inbox first: the UIDs from `uidnext` up, lowest first, in one
  write transaction with the folder's flag changes and vanished UIDs; a folder left partial records `uidnext` above
  the last UID the step's `UID SEARCH` took when it wrote them all, else after the last ingested UID. Then every
  folder's backfill step, the inbox first: the UIDs below `backfill_below_uid`, highest (newest) first, in write
  transactions of at most 50 messages, each moving `backfill_below_uid` down to the lowest UID it wrote; the last batch
  of the step's range moves it to the lowest UID the search took, or sets it `NULL` when the search found every UID
  left. New mail is therefore ingested before older history and never waits for a backfill. The first batch that writes a message whose Date lies before
  the full-content window sets `backfill_index_only`: UIDs only grow, so what is left below the cursor is in practice
  older history, stored as an index, which a native client may then upload (see
  [History upload from a native client](#history-upload-from-a-native-client)). A folder whose backfill a client holds
  under an unexpired lease is skipped by the backfill step (no SELECT); its live step runs as always.
  How far a step reached is decided by its `UID SEARCH`, never by how many messages the `UID FETCH` after it
  returned: a message expunged between the two leaves a gap, not the end of the folder (`ImapFetchedRange`).
- Budget of a pass, shared by all folders and both steps: `IMAP_FULL_MESSAGES_PER_PASS` (25) full messages and
  `IMAP_INDEX_MESSAGES_PER_PASS` (500) index messages, a message whose Message-ID the mailbox already holds counting
  as an index one. A step takes messages in its order until the budget of the next one's kind is spent. Each fetch
  is two steps: a light `UID FETCH` (UID, flags, ENVELOPE, BODYSTRUCTURE, the threading and delivery headers,
  Gmail labels) of the batch, then, outside any transaction, a read of which Message-IDs the mailbox already holds
  (`listKnownMailMessageIds`); only after that a full message's body parts are downloaded and its attachments
  spooled, and every index message's snippet part is read in one partial `UID FETCH … BODY.PEEK[<part>]<0.2048>` per
  distinct part (`fetchSnippets`, decoded by `mail/imapSnippet.ts`). A known message downloads nothing; a known one
  whose meta row is gone by the batch's write (removed meanwhile) ends the batch there, unwritten, for a later pass.
  A pass that leaves new messages or any folder's backfill behind requests a rerun of itself in its final
  transaction, leaves the account due at once and keeps `initial_sync_completed_at` unset; it is set by the first
  pass that ends with every folder's backfill done, or by the upload that finishes the last one. A backfill left to a
  client's lease keeps `initial_sync_completed_at` unset but asks for no rerun: the account is due again in 30
  minutes, when an expired or released lease has given the folder back to the server.
- Vanished UIDs during a backfill: the count check compares server counts, and the UID diff (`UID SEARCH ALL`) runs
  against the known UIDs, the ones ingested so far, so a UID not backfilled yet is never removed and one expunged
  before its backfill is simply not found by it.
- A UIDVALIDITY change. The live step that finds it fetches no flags and lists no UIDs: the known UIDs name other
  messages under the new UIDVALIDITY, so neither their flags nor their absence tells anything. In the transaction
  that resets the folder's state (`resetForUidvalidityChange`) every edge of the folder that carries a UID keeps its
  Email but trades the UID for `staleUid` (`retireFolderUids`), so no reader ever pairs an old UID with the new
  UIDVALIDITY: the vanished diff, the flag observation and write-back, the moves, the content and attachment reads
  (which then search the folder by Message-ID) and the provider search see such an edge as one without a UID. The
  folder's backfill then reaches every message the folder holds and ingests it by Message-ID (without download),
  which gives its edge the new UID. The write that ends the folder's backfill (the server's, or the upload of a
  native client) removes every edge still left with only a `staleUid`, a message the folder no longer holds, and
  marks its Email as a vanished copy's (`removeStaleFolderCopies`); the next final transaction trashes it when it has
  no folder edge left. An Email with a move in flight keeps its edge.
- The mailbox sync guard `lockMailboxSync` (`mail/mailboxSyncGuard.ts`) is a transaction advisory lock on
  `mailbox-sync:v1:<tenant>:<mailbox>`. It requires a tenant scope and a READ COMMITTED transaction of that
  tenant. Optional `maxWaitMs` bounds the wait with a transaction-local `lock_timeout` restored right after
  grant; a timeout throws `MailboxSyncBusyError` (409 `mailbox_sync_busy`).
- In a pass, `enterSyncPass` takes the guard as the first statement of each write transaction, then re-reads
  the Mailboxes item and sync state row; a trashed/missing item, a
  missing row or a paused row (Mail off) ends the pass with no further provider call and no further write. A
  removal or the Mail switch therefore waits for a pass's transaction, not for its provider calls, and a pass it
  overtakes ends at its next transaction. The pass waits for the guard at most
  `MAILBOX_SYNC_PASS_WAIT_MS`; when another pass or a removal still holds it, the pass is skipped and records
  nothing (no failure, status, problem or notification); the sweep re-enqueues an account that is still due.
- A pass with no stored credential, or whose provider refused the stored sign-in, fails with
  `MailReauthorizationRequiredError` (failure kind `reauthorization`, `syncStatus` `needsReauthorization`),
  whatever the status it read: only the user can store one again. The job records it and returns without
  rethrowing, so graphile-worker does not retry it.
- An account whose last failure kind is `reauthorization` is left alone everywhere until a sign-in clears the kind:
  the sweep (`listAccountsDueForSync`) does not list it, live-sync discovery does not host it, and the job's
  prologue ends after the sync state read, before the pass lease, the credential read or any provider call. The
  sign-in again (OAuth reauthorization or the password route) clears the failure record (`clearMailSyncFailure`) in
  the transaction that stores the credential and queues the next pass.
- A failed pass pushes `next_expected_activity_at` out by a jittered delay that grows over the failure streak
  (decorrelated jitter, `mail/mailBackoff.ts`): uniform between the base and three times the previous delay, capped
  at 6 hours. The base is 5 minutes, or for `MailConnectionLimitError` the provider's connection-limit backoff
  (`connectionLimitBackoffSecondsForProvider`, 5 or 10 minutes). The previous delay is read from the row
  (`next_expected_activity_at − last_activity_at` while `failing_since` is set); a successful pass ends the streak.
  A connection-limit failure is not rethrown; other failures are, and the job is not retried (`maxAttempts` 1): the
  sweep queues the next pass once the backed-off `next_expected_activity_at` is due, so a failing server never sees
  a burst of logins.
- `Mailboxes.syncStatus` (`owner: system`) has two writers: the sync job, and the mailbox removal (value
  `needsReauthorization` only, in the transaction that deletes the credential).

### Arrival: live and backfill

- Ingest stamps every new message's `mail_message_meta.arrival` once: `live` for new mail after the account
  connected, `backfill` for history an initial sync or a full resync imports. A message ingested again (another
  folder, a repeat observation, the sync confirmation of a sent message) keeps the stored value; a send claim is
  `live`.
- The anchor is `mail_account_sync_state.connected_at`, set to `now()` by the first pass that finds it unset
  (`anchorMailAccountConnection`) and cleared by `pauseMailAccountSync`, so switching Mail off and on again anchors the
  account as a new one.
- The adapter decides whether the provider reports a message as new (`mail/mailArrival.ts`, `mailArrivalOf`):
  - IMAP: per folder, `mail_folder_sync_state.live_from_uid` is the UIDNEXT selected when the folder's state is first
    established, and again after a UIDVALIDITY reset (`resetForUidvalidityChange` clears it). A UID at or above it is
    new; every message the folder already held, including the rest of a backfill spread over many passes, is not.
  - Gmail: a message reached through `history.list` from the stored history id is new; the full listing of a first
    pass or of the resync after a history invalidation is not.
  - Graph: a message of a delta round started from the stored delta link is new; a delta from scratch (first pass, or
    after `410 Gone`/`resyncRequired`) is not.
- A message the provider reports as new is still `backfill` when its Date is older than `connected_at` less one day
  (`MAIL_LIVE_ARRIVAL_DATE_GRACE_MS`): old mail another client moves into a folder is not new mail. A message without a
  Date is judged by the provider alone.
- Only `live` mail triggers model calls or notifications: the `newEmail` heartbeat (`core.agentRun` with the
  `liveMailFilter` gate, checked before the answer-expected gate's model call), thread project triage
  (`mailThreadProject`, queued by ingest, with the project signal match it runs first), and the
  `calendar_invitation` notification of an iMIP invitation
  (`calendar/invitationIngestAction.ts` still writes the Invitations item of a backfilled message, unnotified, as a
  calendar's initial sync does). Person linking, thread link rules, invitation reply application and search indexing
  run for backfilled mail too.

### Content: full and index

- Ingest stamps every new message's `mail_message_meta.content_state` once (`mail/mailContentState.ts`,
  `mailContentStateOf`); a message ingested again keeps it, a send claim is `full`. A message is `full` when it is
  `live`, or when its Date is at most `MAIL_FULL_CONTENT_WINDOW_DAYS` (90) before the account's `connected_at`;
  older history, and history without a Date, is `index`.
  - Gmail decides by where the pass reaches the message: the live step (`history.list`) stores it `full`, the
    listing by its phase, which Gmail's search decides by the internal date (`full` inside the window, `index`
    beyond it).
  - Graph decides by `mailContentStateOf` with `receivedDateTime` as the Date.
- `full`: `Emails.body` (the HTML part, else the text part), `preview_text` from it, every attachment's bytes as a
  blob with a `mail_attachments` row, a Files item and the `Emails.attachments`/`Threads.attachments` edges, attachment
  text folded into the search text. `mail_attachments.provider_part` records where the provider holds the bytes: IMAP
  the body part id, Graph the attachment id, Gmail the payload's `partId` (Gmail's attachment ids change between
  `messages.get` calls, so they are not stored).
- `index`: `Emails.body` stays empty; envelope, flags, threading headers and folder edges as for `full`;
  `preview_text` from the snippet (IMAP: the first 2 KiB of the text part, else HTML part; Gmail: `snippet`, its
  HTML entities decoded; Graph: `bodyPreview`); for IMAP each attachment as a `mail_attachments` row with `blob_id`
  NULL, its `provider_part` and the size BODYSTRUCTURE gives, and no Files item and no edge; the search text is
  subject, sender, snippet and attachment filenames. A Gmail or Graph index message records no attachment: a
  `format=metadata` fetch lists no parts, and a Graph attachment list per message would cost a request per
  message of the backfill. A row has a blob or a provider
  part (`mail_attachments_stored_or_located_check`).
- Readers of `mail_attachments` treat a NULL `blob_id` as bytes not stored: the thread detail answers each message's
  `contentState` and `preview`, and each attachment's `attachmentId` and `stored` (`blobId`, `fileItemId` NULL); the
  removal impact counts only stored attachments as kept; a Semp attachment reference has no blob; calendar parts
  are read from stored ones only. A forward copies only attachments that have a Files item.

### On-demand content and attachments

- `contentState` as readers see it (`MAIL_MESSAGE_CONTENT_STATES`): `full` (the body is stored, `Emails.body`), `cached`
  (an `index` message with an unexpired row in `mail_message_content_cache`) or `remote` (an `index` message without
  one). The thread detail serves a `cached` message's body from the row (HTML part, else text part, sanitized like a
  stored body) and a `remote` one with both bodies empty; `preview` is always the stored snippet.
- `mail_message_content_cache` (`mail/mailContentCacheStore.ts`): per Emails item (`ON DELETE CASCADE`) the HTML and the
  text part as the provider returned them, unsanitized, with `fetched_at` and `expires_at` = `fetched_at` +
  `MAIL_CONTENT_CACHE_DAYS` (7). An expired row reads as none. Its one writer is `writeMailContentCache`, called only by
  the content route's fetch: it locks the Emails item `FOR KEY SHARE`, writes nothing for a trashed or gone item, and
  upserts on `(tenant_id, item_id)`, so a repeat fetch replaces the row and two writers never fail on each other.
  Trash, Mail off and removal leave rows to expire; a purge removes them with the item.
- `mailContentCacheSweep` (daily 03:55, `api` runtime, system task) deletes expired rows, one transaction per active
  tenant (`forEachActiveTenant`); a failing tenant does not stop the others.
- `GET /api/mail/messages/:emailId/content[?allowRemoteImages=true]` (`mail/mailMessageContent.ts`) answers
  `{ emailId, contentState: "full" | "cached", bodyHtml, bodyText, fetchedAt, expiresAt, attachments }` (the two times
  `null` for a stored body; `attachments` as the thread detail lists them, `{ attachmentId, filename, contentType,
byteSize, stored, blobId, fileItemId }` with `blobId`/`fileItemId` `null` until the bytes are saved, read with the body's
  source before any provider call, `mail/mailMessageAttachments.ts`). A malformed id is 400; an unknown, foreign or trashed id the same 404. A `full` message (or one without
  a meta row) answers its stored body, an `index` message its unexpired cache row; otherwise the body is fetched from the
  provider outside any transaction, written as the cache row in a short transaction and answered `cached`.
  - Before any provider call, an account that is trashed, has no sync state or has Mail off answers 409
    `mail_content_unavailable` with `details.reason` `mailboxUnavailable`; one whose last sync failure is
    `reauthorization` answers `reauthorizationRequired`.
  - IMAP: the stored password (access logged as the user, purpose `imap_content`), then the account's client from the
    sync's factory (the kept session of `sharedImapSessionPool`, else a new connection under the connection limiter).
    Folder edge by folder, those with a UID first: the edge's UID while the folder's UIDVALIDITY equals the stored
    `mail_folder_sync_state.uidvalidity`, else (UID gone, UIDVALIDITY changed, edge without UID) the first five UIDs
    `UID SEARCH HEADER Message-ID` finds in that folder. The body parts are chosen as the full ingest chooses them
    (`walkBodyStructure`), each read up to 16 MiB (`IMAP_CONTENT_MAX_PART_BYTES`) under a 60 s deadline; a SEARCH has
    30 s. Gmail and Graph read the body with the sync's own full read, so it is chosen and annotated as the full ingest
    stores it: Gmail `fetchMessage(id, "full")` (`messages.get format=full` by `provider_message_id`), Graph
    `fetchMessageContent` (`GET /me/messages/{id}?$select=body,bodyPreview,hasAttachments`, then the attachment list
    of a message that has attachments, item and reference attachments annotated into the body; no attachment byte is
    fetched). Both: 30 s per request, every JSON response of the Gmail and Graph clients capped at 64 MiB, 404 = no
    such message.
  - Failures: a refused sign-in is `reauthorizationRequired`; a provider that holds no such message is
    `messageNotFound`; any other provider failure (connect, limiter wait, timeout, refused command, HTTP status) is
    logged by error name with local ids and answered `providerUnreachable`. A database failure keeps its identity.
    Nothing is cached on a failure.
  - Concurrent reads of one message in the process share one fetch (keyed by tenant and item id); a read that missed a
    fetch which just ended re-reads the cache before asking the provider. Only a read that asks the provider is
    counted by the throttle: action `mailContentFetch`, 120 per 15 minutes **per user id** (the `throttle` member, as
    the password routes), refusal 429 `rate_limited` with `Retry-After`.
- `POST /api/mail/messages/:emailId/attachments/:attachmentId/save` (`mail/mailAttachmentSave.ts`) answers
  `{ fileItemId }`. A user action; no agent tool calls it. An attachment of another message, an unknown, foreign or
  trashed id is the same 404. An attachment with stored bytes and a live Files item of the Email (same blob and name)
  answers that item without a provider call. Otherwise the bytes are fetched by `provider_part` (IMAP: the same folder
  and UID resolution, the leaf part streamed with the `MAX_ATTACHMENT_BYTES` cap; Gmail: the message read again with
  `format=full`, the attachment of the stored `partId` and filename taken from it and its bytes read by the attachment
  id of that read (`attachments.get`), or from its inline data; Graph `/attachments/{id}/$value` with the immutable-id
  header). Only IMAP records attachments without bytes (a Gmail or Graph index message records none, and a full
  one stores every attachment's bytes). The bytes are counted by `mailContentFetch`, and written to the mail
  attachment storage before the transaction; a stream that sends nothing for 60 s fails. An attachment the IMAP or
  Gmail client reports over the cap is 409 `attachmentTooLarge` (Graph's stream fails as `providerUnreachable`), other
  failures are answered as for the content route, and the written bytes are removed.
  - The transaction (`saveMailAttachmentFile`, `mail/attachments.ts`) takes the mail-thread guard, locks the
    `mail_attachments` row `FOR UPDATE`, gives a row without bytes the blob (`findOrCreateBlob`, deduplicated by content
    hash) and the stored size, then answers the Email's live Files item over that blob and name or creates one with the
    `Emails.attachments` and `Threads.attachments` edges, as the full ingest does (no attachment text is indexed).
    Concurrent saves queue on the guard and the row, so a second save finds what the first wrote; bytes nothing
    references (a duplicate blob, or a save that lost) are deleted after the transaction.
- Agent reads never fetch a body (`mail.search` asks the providers to search only): `mail.thread.get` gives a
  `remote` message's preview as `bodyText` with a `contentNote` saying its content is not downloaded, and the
  answer-expected gate shows it as a preview marked so; a `cached` message is read like a stored one.

### Search

- Two layers: the local index (`item_search_index`, the thread list's `matchesSearch`) knows an `index` message only by
  subject, addresses, snippet and attachment names, so a word only an older body holds is found at the provider.
  `GET /api/mail/threads?q=` and global search stay local; `GET /api/mail/search` and the `mail.search` tool ask both
  (`mail/mailRemoteSearch.ts`).
- `GET /api/mail/search?q=&mailboxId=&limit=` answers
  `{ threads, localCount, remote: { searched, failed: [{ mailboxId, reason }], unindexed } }`. `q` (trimmed, 1–1000
  characters, required) and `limit` (1–200, default 50) are read as the thread list reads them, a `before:`/`after:`
  that is no ISO date is 400. `threads` are thread list rows: the local matches over every box (a thread with a copy
  outside Junk and Trash, `box: "all"`) together with the threads of the Emails the providers found, which must meet the
  query's operators too (`searchMessageItemIds`), deduplicated, newest first, at most `limit`; `localCount` is how many
  of them the local search matched. A `mailboxId` narrows both; an unknown, foreign or trashed one is the 404 of a
  random id, before any provider call.
- Provider search runs only for a query with free text (`parseMailSearchTerms`: words and quoted phrases, `-` excludes,
  `or` is dropped, at most 8 terms of 100 characters): every operator is a condition on the stored index. Each live
  account with a sync state is searched outside any transaction, at most 3 at a time (`MAIL_REMOTE_SEARCH_CONCURRENCY`),
  with an overall deadline of 15 s (`MAIL_REMOTE_SEARCH_DEADLINE_MS`) and at most 100 hits per account
  (`MAIL_REMOTE_SEARCH_MAX_HITS`); hits are mapped to Emails in a short transaction afterwards. An account with Mail off
  (`mailOff`) or whose last sync failure is `reauthorization` (`reauthorizationRequired`) is reported in `failed`
  without a provider call. A refused sign-in is `reauthorizationRequired`, any other provider failure is logged by error
  name with local ids and is `providerUnreachable`, an account that has not answered by the deadline is `timeout` (its
  Gmail or Graph request is aborted, its IMAP search stops at the next folder, what it finds later is dropped). A
  database failure keeps its identity. A hit no local Emails item records is counted in `unindexed`.
  - IMAP: the stored password (access logged as the user, or `ai_agent` with the run id, purpose `imap_search`), the
    client from the content reads' factory (kept session or a new connection under the limiter). Folders: Inbox, Archive
    and Sent, in that order; an account with an All Mail folder (Gmail over IMAP) is searched there alone. Trash, Junk,
    Drafts and the user's own folders are not searched. Per folder `UID SEARCH` with one `TEXT` per term (`NOT TEXT` for
    an excluded one), 30 s each, newest UIDs first; a non-ASCII term goes with `CHARSET UTF-8`, and a server that
    refuses it is asked again with the terms folded to US-ASCII. A UID maps over the folder edge carrying it while the
    folder's stored UIDVALIDITY equals the one the search selected, as the search began and again in the mapping's
    transaction (a pass that established the folder anew meanwhile gave its edges other UIDs); otherwise, or without an
    edge, it is unindexed.
  - Gmail: `messages.list` with the user's `q` as it is (Gmail's own operators, which `q` shares) and `maxResults=100`;
    Gmail leaves Trash and Spam out. Graph: `GET /me/messages` with `$search="<terms> NOT <excluded>"`, `$top=100` and
    `$select=id`, with the immutable-id header (messages need no `ConsistencyLevel`); Graph searches every folder and
    the local box filter leaves out a thread only in Junk or Trash. Both map by `provider_message_id` of the account; 30
    s per request, ended earlier by the deadline.
- Only a search that asks a provider is counted by the throttle: action `mailRemoteSearch`, 30 per 15 minutes **per user
  id** (the `throttle` member), refusal 429 `rate_limited` with `Retry-After`, before any provider call.
- `mail.search` (capability `mail.read`, approval none, risk `read`, declared for MCP like `mail.thread.get`) takes
  `{ query, mailboxId?, limit? (1–50, default 20) }` and answers compact rows (`threadId`, `subject`, `lastMessageAt`,
  `lastSender`, `snippet`), `localCount`, `remote` and `remoteSearch` (`searched`, `notNeeded`, `unavailable`,
  `runBudgetSpent`, `rateLimited`). A refusal of the provider part makes the call local-only, never a failure. A run
  makes at most 5 provider searches (`MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN`), counted in the process that runs it (no
  per-run budget exists elsewhere); the run's user is counted by `mailRemoteSearch` as well. A human `/mcp` session's
  handler gets the providers and throttle from the custom routes' container; a run's handler is built without it and
  reads them from `bindMailAgentRemoteSearch`, which `semprec-api`'s `createDispatcher` binds. A process that binds
  nothing (`semprec-agents` today, which composes no provider clients) answers local matches with
  `remoteSearch: "unavailable"`.

### History upload from a native client

An IMAP account's older history can be fetched by the user's native app from the user's own network and uploaded,
so the server's address does not pull years of every account's history. The server still stores live mail and the
history inside the full-content window itself; without a client it backfills the rest alone, as above. Gmail and
Graph accounts import their history server-side only. Code: `mail/mailHistoryUpload.ts`; the raw responses are parsed
by `mail/imapFetchResponseParser.ts` (imapflow 1.7.6's own `ImapStream`, parser and `tools.formatMessageResponse`,
internals proven against the real library by its unit test; an upgrade must re-prove them).

- The lease. `mail_folder_sync_state.client_backfill_lease_token` and `client_backfill_lease_until`
  (`MAIL_HISTORY_LEASE_MS`, 10 minutes). While the lease is unexpired the server's backfill skips the folder; the
  live step is unaffected. A lease ends at its expiry, by the release route, or with the folder's state on a
  UIDVALIDITY change (`resetForUidvalidityChange` clears it and `backfill_index_only`). While a client holds the
  lease, the upload is the second writer of the folder's `backfill_below_uid`, and the one that finishes an account's
  last folder backfill sets `initial_sync_completed_at` (`recordImapInitialSyncCompleted`).
- Every route answers a malformed, unknown, foreign or trashed mailbox id with the same 404 `not_found`, and a mailbox
  whose sync mode is not `imap`, that has Mail off or no sync state, or whose last sync failure is `reauthorization`
  with 409 `mail_history_unavailable`, `details.reason` `notImap`, `mailboxUnavailable` or `reauthorizationRequired`.
  Each runs in READ COMMITTED transactions that take the mailbox sync guard first (≤ 15 s, else 409
  `mailbox_sync_busy`), so a removal or the Mail switch waits for them as for a pass's, and re-read the Mailboxes item
  and the sync state under it. The claim and the upload count against the per-user throttle, action
  `mailHistoryUpload`, 600 per 15 minutes; a refusal is 429 `rate_limited` with `Retry-After`.
- `POST /api/mail/mailboxes/:id/history-index/claim`, body `{ leaseToken? }` (a UUID; without it a new token). One
  statement leases to the token every folder of the mailbox (live Folder items with a `providerId`) whose backfill is
  index-only and unfinished and that no other token holds unexpired, and renews those the token holds. Answer:
  `{ leaseToken, leaseExpiresAt: string | null, folders: [{ folderId, path, uidvalidity, backfillBelowUid }],
  pendingFullBackfill: boolean }` (`leaseExpiresAt` `null` when nothing was leased). `pendingFullBackfill` is true
  while the mailbox has no folder state yet, or some folder is not established or still in the server's in-window
  backfill (unfinished, not index-only): claiming again later may lease more.
- `POST /api/mail/mailboxes/:id/history-index/release`, body `{ leaseToken }`: ends the token's leases on the mailbox's
  folders, expired ones included; answers `{ released }`. Not throttled.
- `POST /api/mail/mailboxes/:id/history-index`, body (at most `MAIL_HISTORY_MAX_BODY_BYTES`, 8 MiB, declared as the
  route's `maxBodyBytes` and enforced while the adapter reads it, 413 `payload_too_large` beyond):
  `{ leaseToken, folderId, uidvalidity, rangeHigh, rangeLow, uids: number[], messages: [{ uid, fetch }] }`. One
  contiguous slice of the folder's history, newest first: the client sends `UID SEARCH UID rangeLow:rangeHigh-1`, then
  `UID FETCH <uids> MAIL_HISTORY_FETCH_ITEMS`, exactly

  `(UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (REFERENCES DELIVERED-TO X-ORIGINAL-TO ENVELOPE-TO LIST-UNSUBSCRIBE LIST-ID PRECEDENCE AUTO-SUBMITTED)] BODY.PEEK[TEXT]<0.2048>)`

  (the light fetch's items and header fields, `IMAP_LIGHT_FETCH_HEADERS`, plus the first `IMAP_SNIPPET_BYTES` octets
  of the TEXT section), and uploads each untagged FETCH response's bytes, as its server sent them (literals inline),
  base64 in `fetch`. Other data items a server adds (MODSEQ under CONDSTORE) are ignored; an `EMAILID` a client asks
  for on an OBJECTID server becomes the provider message id, as in the light fetch.
  - Validated before anything is written, a malformed one 400 `validation_failed` naming the field by its path
    (`messages.3.fetch`): integers in the IMAP number range, `rangeLow < rangeHigh`; `uids` unique, inside
    `[rangeLow, rangeHigh)`, at most `MAIL_HISTORY_MAX_MESSAGES` (500); `messages` at most 500, exactly one per listed
    UID; each `fetch` strict base64 of at most `MAIL_HISTORY_MAX_FETCH_BYTES` (64 KiB) holding exactly one untagged
    FETCH response of that UID with FLAGS, ENVELOPE, BODYSTRUCTURE, the header fields and the TEXT section.
  - Each response is read as the light fetch reads its own (`lightFetchedMessageOf` in `mail/imapLightFetch.ts`:
    envelope, flags, threading, delivery and bulk headers, attachments from BODYSTRUCTURE with their part ids and
    sizes). The snippet comes from the part the light fetch reads it from (the text part, else the HTML part): a
    single-part message's TEXT section itself, else that part found in the cut TEXT section by the boundaries
    BODYSTRUCTURE names, its header block skipped (`bodyPartPrefixInText`); a part whose content starts beyond the
    cut, or one inside an attached message, gives no snippet. Of a multipart message less than 2 KiB of the part is
    read, so its search text can be shorter than the server's; the 200-character preview is the same.
  - Written in READ COMMITTED transactions of at most `IMAP_MESSAGES_PER_BATCH` (50) messages, newest first: mailbox
    sync guard → the mailbox and its sync state re-read → mail-thread guard → the folder's sync state row
    `FOR UPDATE`, which must still hold the uploaded UIDVALIDITY (else 409 `mail_history_uidvalidity_changed`), an
    unexpired lease of the token (else 409 `mail_history_lease_expired`) and the cursor the batch continues (the first
    at `rangeHigh`; else 409 `mail_history_range_stale` with `details.backfillBelowUid`, the cursor the folder holds).
    A folder that is not one of the mailbox's is 404 `not_found`. Each message is ingested as a server backfill
    batch ingests it, `arrival` `backfill` and `content_state` `index` (a message inside the window too; its body is
    read on demand), with the moves in flight protected; a known Message-ID converges as always. Then the cursor moves
    to the lowest UID the batch wrote, the last batch's to `rangeLow` (`NULL` for 1, the folder's backfill done, which
    removes the edges a UIDVALIDITY change left with only a `staleUid` as the server's backfill does), and the lease is
    renewed. A refusal after a committed batch leaves that prefix written; the claim answers the cursor.
  - Answer: `{ accepted, backfillBelowUid: number | null, leaseExpiresAt }`.
- The client. The mobile apps upload the history of an IMAP account right after the person connected it with a
  password, while that password is in memory; it is never stored on the device. One IMAP connection per accounts
  screen, implicit TLS on 993 with the certificate checked against the host name (a STARTTLS-only server is left to
  the server's backfill), read-only (`EXAMINE`). Per leased folder whose UIDVALIDITY matches, from the cursor down: a `UID SEARCH`
  per 2000 UIDs, a `UID FETCH` per 200, uploads well under the body limit; a stale cursor is taken over, a response
  over 64 KiB ends the client's work on that folder just above it, and the lease is renewed by claiming again with the
  same token every 4 minutes. It stops on `mail_history_lease_expired`, `mail_history_unavailable`, a 429 or any other
  failure, and releases the lease whenever it ends, also when the screen closes. Code and the client-side rules:
  `mobile/docs/architecture.md`, "Mail history from the device".

### IMAP connection limits and kept sync sessions

- `mail/imapConnectionLimiter.ts` is the one per-process limiter of IMAP connections, shared by sync passes, moves,
  Sent APPEND and IDLE (`sharedImapConnectionLimiter`). It bounds open connections per account
  (`imapConnectionLimitForProvider`: the mailbox's `connectionLimit`, else Gmail 5, iCloud and Outlook 3, others 2),
  open work connections per server host (`HOST_IMAP_CONNECTION_LIMIT`, 10, the same for every host), and logins per
  server host (`HOST_IMAP_LOGINS_PER_MINUTE`, 20: a burst of 20, then one every 3 s). A slot is taken account first,
  then host. Waits are FIFO and reject after 3 minutes; an IDLE lifecycle's waits also end when it stops.
- An IDLE connection, open for hours, counts against its account only (`kind: "idle"`): counted against the host,
  it would cap how many accounts of one provider can listen at all. Everything else (`kind: "work"`: a sync session,
  the IDLE folder lookup, a Sent APPEND) counts against both.
- `mail/imapSessionPool.ts` keeps one IMAP sync connection per account open between uses in the process
  (`sharedImapSessionPool`, used by the composition root's sync adapter, its on-demand content reads and the provider
  search). The move drain and the pass of a job, consecutive passes and content reads take the same connection in turn,
  exclusively; a second concurrent caller gets a connection of its own. A kept connection is reused only when it was
  opened with the same server settings, user name and credential, answers a NOOP, and nothing it ran failed
  (`ImapMailClient.isReusable`); a rejected operation, a failed or timed-out fetch, an ambiguous move or a changed
  sign-in closes it instead.
- A kept connection holds its account and host slots while it is unused, because the provider counts it, and gives
  them up as soon as another caller has to wait for one of them (the limiter asks it to close). It is closed after
  4 minutes unused (`IMAP_SESSION_IDLE_TIMEOUT_MS`, below common server idle cutoffs), on `closeAccount` (the
  live-sync control calls it after every `restartAccount` and `stopMailbox`: a sign-in again, Mail switched off, a
  removal) and on shutdown (`close()`, after which checkouts are refused).

### Live sync root and hosted lifecycles

- `mail/mailLiveSyncRoot.ts` (`createMailLiveSyncRoot`) decides which accounts a process hosts (IMAP IDLE,
  Gmail watch, Graph subscription lifecycles), discovering live Mailboxes per active tenant in page
  transactions.
- Discovery takes no sync guard and never waits: for an account without a sync state row it seeds one only
  after `SELECT … FOR SHARE SKIP LOCKED` on the live Mailboxes item (`ensureMailAccountSyncStateOfLiveMailbox`).
  A skipped account is left out of the pass silently, as are a paused one (Mail off) and one whose last sync
  failure is `reauthorization`; a hosted account left out is stopped by the pass. `restartAccount` does not host an
  account the root does not host, so an account signed in again is hosted by the next discovery pass.
- `restartAccount(mailboxItemId)` stops and re-hosts one entry, running in the root's captured async context
  inside `runAsSystem("mail:liveSync")`; the tenant comes from the recorded entry, never from the caller, and a
  caller in a tenant scope only reaches its own tenant's entries. The root must be created outside any scope.
- `stopMailbox(tenantId, mailboxItemId)` waits for in-flight discovery passes and restarts, then stops the
  entry once. Routes reach the root through `createMailLiveSyncControl`
  (`services/semprec-api/src/mailLiveSyncControl.ts`), bound before the server listens; unbound calls refuse
  with `CustomRouteConfigurationError`; `startMailbox` always refuses.
- The hosted IMAP lifecycle owns its discovery/startup task. A start queues the account's pass once, however often
  its discovery is retried. The folder lookup runs under a work slot of the limiter and each folder's IDLE
  connection under an IDLE slot. Policy refusals and transient errors go into a jittered backoff (decorrelated
  jitter between 5 s and 5 min), while `MailReauthorizationRequiredError` (the composition root's `getCredential`
  throws it when no credential is stored; its connection factory classifies a refused login as it) ends the
  discovery or the folder's loop after one report until `restartAccount` hosts a new lifecycle; stop cancels waits
  (a slot or login wait included) and joins all owned work before pool shutdown. IDLE logout grace is 10 s, then
  public `close()`; work that has not settled keeps stop pending (it is never abandoned as "done").
- The Gmail Pub/Sub dispatcher (`createGmailPubSubDispatcher`, `mail/gmailWatchLifecycle.ts`) routes each
  notification with `route_gmail_address`, enqueues `mailAccountSync` per target tenant, and acknowledges only
  after every hand-off.
- Graph ids: every Graph mail request (sync reads, attachment streams, flag write-back, moves, drafts and sends,
  the subscription's creation) sends `Prefer: IdType="ImmutableId"` (`mail/graphImmutableIds.ts`), so
  `provider_message_id` of a Graph account holds the immutable id, which survives a folder move; a move response
  names the same id, and change notifications name messages by it.
- `semprec-api` shutdown order (`services/semprec-api/src/shutdown.ts`): listener close → sync server close →
  HTTP drain → `gmailPubSubDispatcher.stop()` → `mailLiveSync.stop()` → `queueRuntime.stop()` →
  `imapSessions.close()` (the kept IMAP sync sessions, once no pass runs) → `pool.end()`.
  A future long-lived outbound loop that enqueues work stops after the drain, before what it would race.

### Provider moves

- A user move records a desire in `mail_message_move_sync_state` (`mail/mailMessageMoveSyncStore.ts`,
  `recordDesiredMailMessageMove`); sync executes it in a move phase **before** the reconcile
  (`mail/mailMessageMoveSync.ts`). Independently callable reconcilers only observe move state.
- Each step is claimed atomically in a short guarded transaction (operation token, monotonic desired revision,
  captured revision, durable phase, bounded validated evidence) and committed before dispatch. Only the
  claiming token records the outcome. The provider call runs outside every transaction, on the account's IMAP sync
  connection (the kept session, see above), under a 30 s elapsed deadline per preparation/step. A drain runs its
  moves one after another on one connection; a move after which the connection is not known to be clean closes it,
  and the next move opens another.
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
  `mail.thread.proposeTask` tool, the attachment save (it writes a `Threads.attachments` edge), the project signal apply,
  thread project triage and the mail purge hook.
- It serializes all thread decisions of a tenant across mailboxes for the lifetime of the transaction that takes
  it; no sync pass, content read, attachment save or project triage holds it across a provider or model call.
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
- Edges of `Threads.company`/`project` stamp the thread's list row, which publishes its `mailThread` invalidation
  after commit (Thread list changes).
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

### Thread list changes

The server index stays the only source of truth; a client keeps the rows of a list view and asks only for what
changed since (`mail/mailThreadChanges.ts`, hooks in `mail/mailThreadChangeHooks.ts`).

- `GET /api/mail/threads` answers `changesCursor` beside each page, read in the page's own `repeatable_read`
  snapshot. `GET /api/mail/threads/changes?since=<cursor>` takes the list's view filters (`box`, `folderId`,
  `mailboxId`, `projectId`, `areaId`, `personId`, `unread`; no `q`, a search is not a view) and answers
  `{ cursor, threads, removed, reset }` in one `repeatable_read` snapshot: `threads` are the stamped threads still in
  the view, shaped as the list shapes them, `removed` the stamped ids that are not (moved out, merged away,
  deleted). A malformed or missing `since` is 400. `reset: true` (no rows) when the cursor names another counter
  epoch, a step the tenant never reached, a step before the last change of every row, or more than
  `MAIL_THREAD_CHANGES_LIMIT` (500) changed threads; the client then reads the first page again.
- The cursor is `{ epoch, step }` of the tenant's `mail_thread_change_counters` row. A transaction that changes a
  list row records the thread (`touchMailThreads`, or `touchAllMailThreads` for a change of every row) in a
  transaction-local set; its pre-commit flush (`runBeforeCommitOnce`) increments the counter row by one step and
  upserts `mail_thread_changes (thread_id, seq)` with that step, then registers one tenant-wide `mailThread`
  invalidation per thread after commit. `touchAllMailThreads` sets `reset_seq` to the step instead.
- Why the order is the commit order: the counter row's lock is taken in the flush and held until `COMMIT`, so a
  second transaction gets its step only after the first committed. A reader whose snapshot shows step `n` therefore
  sees every transaction of steps `≤ n` and none above, and the rows it reads reflect exactly those. A later delta
  from `n` lists every thread stamped `> n`; a transaction that recorded its change before another but committed
  after it still gets the higher step. A timestamp or a sequence drawn mid-transaction would not hold this.
  `mail_thread_changes` has no foreign key, so a thread deleted or merged away keeps its row and reads as removed.
- Who stamps: ingest of a new message; the meta deletes of a removed item (purge, Mail off) and merges (both
  threads); thread actions and every other `announceMailThreadChanged` caller (send, draft retirement, draft
  writes); an update of an Emails item's `read`, `flagged`, `name` or `date` (flag observations of a sync included),
  and its trash or restore; an edge of an Emails item's `folder` or `senderPeople`/`recipientsPeople`, of a Threads
  item's `project` or `company`, or a project's `area`, created or deleted (a metadata update or a repeated create
  only on a Sent folder edge, whose UID decides `received`); a project's or company's `name`, trash or restore (its
  threads); a person's `name`, `relationship`, trash or restore and a released or claimed `person_email_index`
  address (threads with mail from those addresses). A mailbox's `name`, `provider` or `addresses`, a folder's
  `specialPurpose`, and the trash or restore of either change every row: `touchAllMailThreads`.
- Not stamped: the `links` value-link states of a row change without an edge change only (the mobile list does not
  read them). `mail_thread_changes` keeps one row per thread ever stamped, deleted ones included.

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

### Project signals

- `project_mail_signals` (one row per project, `mail/projectMailSignalsStore.ts` its only writer; the row goes with
  the project's item) holds a project's own `domains`, `addresses` and `keywords`. The addresses of the project's live
  `people` (from `person_email_index`) count as signals too and are not copied. Routes (session user): `GET`/`PUT
  /api/mail/projects/:projectId/signals` (replace, last write wins), `POST …/signals/preview` (optional
  `{ draft }` matched instead of the saved set; answers `{ total, alreadyAssigned, threads }`, at most 50 thread list
  rows, newest first) and `POST …/signals/apply` (`{ threadIds }`, at most 200; answers `{ assigned, skipped }`). An
  unknown, trashed or foreign project is 404.
- Normalized at the boundary (`parseMailSignalSet`): a domain is the lower-case host `webHost` gives (URL or bare host,
  no `www.`, needs a dot), an address trimmed and lower-cased, a keyword trimmed with its whitespace collapsed; at most
  50 domains, 100 addresses and 50 keywords of 100 characters, duplicates dropped.
- Matching (`mail/projectMailSignals.ts`, over the local index only): a thread matches when one of its counted messages
  (not a draft, not only in Junk or Trash) has a sender, `to` or `cc` address among the addresses, or at a domain or a
  subdomain of it, or when its `item_search_index` vector matches a keyword. A freemail domain (`FREEMAIL_DOMAINS`) is
  no domain signal and the tenant's own mailbox addresses never match. A keyword's words are folded (lower case, no
  diacritics), lose one Czech case or number ending if at least four letters remain (`mail/mailSignalKeywords.ts`) and
  match as `czech_simple` prefixes (`faktur:*`), in order and adjacent; a word under four letters or holding a digit
  matches exactly.
- Open thread: a live Threads item with no `Threads.project` edge and no project value link in any state. The preview
  lists open matches and counts the others as `alreadyAssigned`. The apply writes, in one transaction: mail-thread
  guard → project `FOR SHARE` → its signals row `FOR SHARE` → each matching listed Threads item in id order (locked,
  rechecked open) → the edge through `createRelationWithClient` as the session's user, the write of a user's own
  project edit. Only the saved signals count there, and only the preview and the apply ever look at history.
- Live triage (`mailTriageThreadProject`, still 60 s after the first inbound live message) matches first, under the
  mail-thread guard and the Threads item lock: exactly one matching `inProgress`/`longTerm` project is written by the
  resolver link rule `threadProjectFromSignals` (no inputs, so nothing else queues it; source: the project, key
  `mailSignals`) without a model call; several restrict the model's candidates to them; none leaves every active
  project as before. A thread that inherited from its company before the task runs is left alone, and the company
  rules leave a signal link alone.

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
- MCP: tools opt in with `mcp: { humanHandlerExport }` (`mail.thread.get`, `mail.search`, `mail.draft.create`,
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
streams, Gmail/Graph send and upload, provider moves, hosted IDLE, credential verification, removal cleanup, the
on-demand content and attachment reads and the provider search.

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
- History claim, release and upload: mailbox sync guard → (upload) mail-thread guard → folder sync state rows.
- Pass lease claim and release: the sync state row alone, then (release only) the follow-up job's insert.
- Sync state row → Mailboxes item (sync job failure/activity writes, removal, reauthorization).
- Service switch / removal: mailbox sync guard (Mail) → calendar sync guard (Calendars) → sync state row (Mail)
  → Mailboxes item. Mail-off chunk: sync state row (share) → mail-thread guard → Mailboxes item (share) → member
  rows.
- Send claim: sync state row (share) → Emails item → `mail_drafts` row → mail-thread guard.
- Merge: thread guard → both Threads items (UUID order) → definition reservations (id order) → edges.
- Draft writers: Emails item → `mail_drafts` row → Files item.
- Attachment save: mail-thread guard → `mail_attachments` row → blob → Files item and its edges.
- Inbox: source item → attachment row; source → blob; card holders never wait for the source and source
  holders never wait for a card.
- Value-link evaluation: target item row → its link row.
- Project signal apply: mail-thread guard → project item (share) → `project_mail_signals` row (share) → Threads items
  (id order) → relation definition. Signal triage: mail-thread guard → Threads item → its link row.

## Related rules

- `fatal` is written only by the shared fatal handlers and by a service's `registerShutdownSignals` when
  `shutdown()` rejects, immediately before `process.exit(1)`; every other failure logs at `error` or below
  (`backend/packages/shared/src/logger.ts`).
- Semp chat turns (`sempMessage`) run on `tenantLane("semp-chat")` (`semp/sempMessageQueue.ts`), FIFO per tenant,
  with `maxAttempts: 1` and `jobKeyMode: "unsafe_dedupe"`; outside a tenant scope enqueueing throws.
