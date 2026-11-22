# Tenancy and security

A tenant is one user's complete Semprec environment, 1:1 with that user. Tenants share nothing. All
tenants live in one database and one schema. Postgres row-level security (RLS) isolates them, and a
tenant scope that every process carries in memory selects the tenant.

Related documents:

- [../operations/database-roles.md](../operations/database-roles.md): the runtime roles, their
  grants per table, the DDL functions and the router function table. This document gives the rules
  and does not repeat those tables.
- [../operations/tenancy.md](../operations/tenancy.md): the go-live security gate and its open
  production evidence.
- [data-model-and-writes.md](data-model-and-writes.md), [transactions-and-side-effects.md](transactions-and-side-effects.md)
  and [edges-io-and-errors.md](edges-io-and-errors.md) for the write path, locking and the request edge.

## Tenant isolation

### Row-level security

- `tenants(id, status ∈ provisioning|active|suspended|deleting, created_at, status_changed_at)` is
  global. `users.tenant_id` is `NOT NULL UNIQUE`, and `users.role ∈ admin|member`.
- `app_current_tenant()` is `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. The `NULLIF`
  is required: once a transaction-local `set_config` ends, the setting reads `''`, not NULL.
- `app_tenant_default()` returns `app_current_tenant()` and nothing else. It does not fall back to a
  sole tenant. Outside a scope a tenant table shows no row, and an insert that relies on the default
  is refused.
- Every tenant table has:
  - `tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id)`;
  - `ENABLE ROW LEVEL SECURITY`;
  - the RESTRICTIVE policy `tenant_isolation USING/WITH CHECK (tenant_id = (SELECT app_tenant_default()))`;
  - the PERMISSIVE policy `tenant_rows USING (true) WITH CHECK (true)`.

  The isolation policy is restrictive, so no later permissive policy can widen it.
- `FORCE ROW LEVEL SECURITY` is not used. The migrating superuser owns the tables and bypasses RLS
  anyway. What protects the data is that no runtime role is a superuser, has `BYPASSRLS` or owns a
  table. Every service checks this at startup (`backend/packages/data/src/db/runtimeRoleAssertion.ts`).
- Child tables reference their parent through composite tenant-consistent foreign keys over
  `(tenant_id, …)`, so a child row cannot point into another tenant. A key to an item is only
  `(tenant_id, <column>) REFERENCES items (tenant_id, id)`, with no single-column twin
  ([data-model-and-writes.md — Storage](data-model-and-writes.md#storage)).
- An operator with superuser access can read every tenant. There is no per-user content encryption
  beyond the secrets described under [Third-party secrets](#third-party-secrets).

### Table classification and unique keys

- Every table carries `COMMENT ON TABLE <t> IS 'semprec:tenancy=tenant'` or `'semprec:tenancy=global'`,
  written by the migration that creates it. Global is only for identity-plane, admin-plane and
  operator tables that hold no user content.
- Every unique index, unique constraint or primary key on a tenant table leads with `tenant_id`.
  Two exceptions: a server-generated surrogate key, and a key scoped by the server-generated id of a
  parent row in the same tenant (such as `properties (database_id, key)`). Unique and foreign-key
  checks ignore RLS, so any other global key works as an existence oracle and lets tenants collide.
- Keys that stay global on purpose: `users.email`, token hashes, `graph_subscription_id`, push
  endpoints and device tokens, process and check keys.

### Deploy-time verification

`backend/packages/data/src/db/tenancyInvariants.ts` (`verifyTenancyCli.ts`, run by `deploy/deploy.sh`)
refuses a catalog that breaks any of these: table classification, `tenant_id` column shape, RLS and
both policies, the strict `app_tenant_default()`, runtime role attributes, foreign keys to `items` over
`(tenant_id, id)`, `SECURITY DEFINER` function shape, and validated tenant foreign keys. The verifier checks the
declared shapes. It does not prove arbitrary policy expressions or function bodies correct.

## Database roles

### Runtime roles

The roles and their grants are listed in [database-roles.md](../operations/database-roles.md).
The rules:

- `semprec_data` hosts the choke point. Only `semprec-api`, `semprec-agents` and
  `semprec-transcribe` connect with it.
- `semprec_side` can read the choke-point tables but cannot write them, and has full DML on module
  side tables and the queue schema. Every other process connects as `semprec_side`. A write to a
  choke-point table from this role fails in Postgres.
- A table that holds a bearer credential, a session secret or a delivery endpoint, or a row that
  makes an actor (`agent_runs`, `agent_run_mcp_credentials`, `approval_requests`,
  `push_subscriptions`, `sessions`, `password_reset_tokens`, …), is granted directly to
  `semprec_data` and gets nothing on `semprec_side` beyond what that document lists. A compromised
  side process must not be able to mint a session or an MCP run credential, or register a push
  endpoint.
- A new table extends the grant lists explicitly in its own migration. No default-privilege rule
  grants tables automatically.
- Accepted remainder: `semprec_side` still reaches every module side table of any tenant it names
  with `set_config`, including the encrypted `external_credentials` and the wrapped `tenant_keys`.

### SECURITY DEFINER functions

- A runtime role gets a DDL capability only through a `SECURITY DEFINER` function created by a
  migration. Such a function is owned by the migrating role, runs exactly one narrow statement with
  identifiers and literals escaped through `format('%I'/'%L')`, references objects
  schema-qualified, revokes `EXECUTE` from `PUBLIC` and grants it to the one role that needs it. A
  runtime role never gets DDL through a schema `CREATE` grant or through table ownership. No such
  function exists: the choke point runs no DDL.
- A definer function that reads or writes a tenant table confines itself to `app_current_tenant()`,
  either by filtering on it or by checking the referenced row's tenant.
- Its `search_path` is `pg_catalog`, then only schemas in which no runtime role can create objects,
  then `pg_temp` last. Without `pg_temp` at the end, a session could shadow a type or relation the
  body names and run code as the owner. The verifier refuses any other shape in every schema.
  Qualifying names inside bodies is also recommended, but the guarantee rests on the setting.

### Cross-tenant router functions

- An external identifier that names a tenant before any tenant is known (a Graph subscription id, a
  Gmail address, a calendar push channel id), or an operator aggregate across tenants, goes through a `SECURITY DEFINER`
  function owned by `semprec_router`. That role is `NOLOGIN BYPASSRLS` and holds column-level
  `SELECT` only on the columns its functions read.
- A router function pins `search_path` (ending in `pg_temp`), revokes `EXECUTE` from `PUBLIC`,
  grants it to exactly one runtime role, and returns only ids or numbers, never content. The caller
  then enters `runInTenant(<returned tenant>)` and reads everything else under RLS.
- Each router function needs its own migration, a row in database-roles.md and a privilege test.
- The following are never allowed: a runtime role with `BYPASSRLS`, superuser or table ownership;
  `SET row_security = off`; a permissive policy that widens visibility; one query that reads several
  tenants' rows.

## Tenant scope

### Scope API

`backend/packages/shared/src/tenantScope.ts` keeps the scope in an `AsyncLocalStorage`:

| Current scope | `runInTenant(T)`             | `runAsSystem(r)`             |
| ------------- | ---------------------------- | ---------------------------- |
| none          | enters T                     | enters system `r`            |
| system        | enters T                     | system, inner reason wins    |
| tenant T      | runs `fn`                    | `TenantScopeConflictError`   |
| tenant U      | `TenantScopeConflictError`   | `TenantScopeConflictError`   |

- `runInTenant` accepts only a canonical UUID. Postgres sees a system scope as no tenant.
- `runDetachedAsSystem` starts a fresh system scope whatever the current one is. It is used only to
  open shared I/O resources, never to run work.
- Use `AsyncLocalStorage.run` only, never `enterWith`, which would leak the scope into the
  surrounding async context.
- `enforceTenantScope(site)` runs at every database access site. When `SEMPREC_TENANT_SCOPE` is unset,
  empty or `strict`, a missing scope throws `TenantScopeMissingError` before a connection is taken.
  `warn` is an operator escape hatch that only logs `tenant_scope_missing`, and production must not
  set it.

### Pool paths

In `backend/packages/data/src/db/pool.ts`, an active scope sets the GUC `app.tenant_id` (`''` for
system):

- `withTransaction` runs `set_config(..., true)` right after `BEGIN`;
- `pool.query` runs `BEGIN`, a transaction-local `set_config`, the statement and `COMMIT` on one client;
- `pool.connect()` sets the GUC for the session, and `release` resets it. A failed reset destroys the
  connection.

Physical connections open inside `runDetachedAsSystem`. A socket's callbacks run in the async context
that opened it, so a connection first opened inside a request would otherwise deliver its `LISTEN`
notifications in that request's tenant for its whole life.

### Trusted tenant sources

Only these sources may supply a tenant identity:

- the authenticated session;
- the queue job envelope, stamped from the producer's scope by `enqueueJob`;
- a NOTIFY payload whose tenant Postgres computed in the publishing statement;
- a caller authenticated with an internal token, cross-checked against a row visible in that tenant;
- an MCP run credential;
- a router function that resolves an external identifier.

A tenant id from a request body, query string, path segment, caller-settable header, job payload
field or model output is a claim by the caller and is never trusted. Code never picks "the" user or
tenant by earliest, first or `LIMIT 1`.

### System work fans out per tenant

- Long-lived loops, listeners and registries start inside `runAsSystem` and re-enter a tenant
  explicitly for each message or job.
- Scheduled sweeps call `forEachActiveTenant` (`backend/packages/data/src/tenancy/forEachActiveTenant.ts`).
  It runs the work in each active tenant's own scope, one tenant after another, starting at a
  rotating offset. When one tenant fails, the others still run. Failures are logged by error class
  name only and rethrown afterwards as one `AggregateError`, so the job is retried. Suspended,
  provisioning and deleting tenants are skipped. Calling the helper from a tenant scope throws.
- Deploy-time per-tenant work (provisioning and keeping tenant data current) uses
  `forEachMaintainedTenant` (`tenancy/provisionTenant.ts`). It visits `provisioning`, `active` and
  `suspended` tenants, never `deleting` ones.
- Queued tenant jobs of a non-active tenant complete as no-ops.

### Queue lanes and job keys

- Serialized work and bulk or heavy work run on a `<lane>:<tenantId>` queue built by
  `tenantLane(lane)` (`tenancy/tenantLane.ts`). The lane comes from the enqueuing scope, never from
  payload data. Lanes run independently across tenants and stay serialized within one tenant.
- graphile-worker job keys are global. A producer whose key could repeat across tenants embeds the
  scope's tenant id in the key, for example
  `valueLinksPropagate:<tenantId>:<ruleKey>:<sourceItemId>:<hop>`. It rejects a missing or system
  scope before enqueueing.
- Item-search jobs (`itemSearchReindexDependents`, `itemSearchBackfill`, `itemSearchPageText`) are
  queued only through `search/searchLaneEnqueue.ts`. That module registers the prepared job on the
  managed invocation (`registerSearchJob` in `db/pool.ts`) and does not call `add_job` inline. A
  registration is refused when it comes from a client other than the active owner's, when the task
  is not a search task, or when its tenant differs from the one the invocation was opened in.
- Between a successful body and `COMMIT`, the invocation flushes its registrations:
  - it checks that the search task identifiers are registered, and fails closed if they are not;
  - it takes the advisory transaction lock `(2332, hashtext(tenantId))`, or `(2333, 0)` for system
    scope;
  - it adds the jobs in (identifier, key) order.

  `ensureQueueSchema` (`backend/packages/queue/src/index.ts`) pre-registers the three identifiers, so
  the flush never inserts task rows. These rules keep search enqueues from deadlocking against each
  other.
- Two-key advisory lock classes in use: 2331 (seed), 2332/2333 (search flush), 2334 (session device).
  A new two-key lock takes an unused class.

## Third-party secrets

- Every third-party secret is stored in `external_credentials` and sealed with XChaCha20-Poly1305
  (`backend/packages/credentials/src/index.ts`) under a per-tenant 32-byte data key. The associated
  data is `"${tenantId}:${itemId}"`, so a ciphertext copied to another row or tenant does not open.
  Only the `tenant` scheme exists.
- The tenant data key lives in `tenant_keys`, wrapped under `CREDENTIALS_MASTER_KEY` with the
  associated data `semprec:tenant-key:v1:<tenantId>`. `master_key_version` records which master key
  wrapped it. The key store is `backend/packages/data/src/credentials/tenantKeysStore.ts`.
- `tenant_keys` has no `UPDATE` grant (a rewrite would orphan everything sealed under the key) and no
  `ON DELETE CASCADE`. Deleting the row is the crypto-shred of account deletion.
- `tenant_keys` is kept out of the long-retention main backup and has its own 7-day backup. Losing
  that backup loses every tenant's secrets.
- Only the processes that decrypt credentials hold the master key. Neither side-role process does.

## Identity, sessions and credentials

### Sessions and login

- Browser sessions use the cookie `Path=/; HttpOnly; Secure; SameSite=Lax`. Native clients send the
  session token as `Authorization: Bearer` (preferred over the cookie, `authHandler.ts`). MCP clients
  on `/mcp` send a bearer token too.
- `verifySessionToken` reads the session and tenant status without locking and writes only
  `last_seen_at`. A suspension stops the next request, not one that is already authenticated.
- `login` reads the tenant binding without locking for every known user before `verifyPassword`, so
  a refusal for a non-active tenant costs the same as a wrong password.
- On success, `login` creates the session in one transaction that:
  1. re-reads the binding with `lockUserTenantBinding` (user row `FOR KEY SHARE`, then tenant row
     `FOR SHARE`);
  2. takes the installation lock `lockSessionDevice`, which is
     `pg_advisory_xact_lock(2334, hashtext('semprec_device:<userId>:<deviceId>'))`;
  3. creates the session and revokes the user's other unrevoked sessions with the same `deviceId`
     (`sessionsStore.revokeSessionsForDevice`), together with their push subscriptions.

  A login without a `deviceId` revokes nothing. The mechanism relies on READ COMMITTED.
- A failed `login_attempts` row is auto-committed on the `Pool` so that the operation's rollback
  cannot erase it (see [edges-io-and-errors.md](edges-io-and-errors.md#records-that-must-survive-a-failure)).
  The per-(email, address) lockout reads these rows.

### Credentials issued on tenant status

- A path that issues credentials or tenant-bound state because the tenant is active (`login`,
  `requestPasswordReset`, `resetPassword`, `changePassword`) re-reads the status with
  `lockUserTenantBinding` in the transaction of the write, never from an earlier unlocked read.
- Lock order is user row, then tenant row, then session rows, then push subscription rows.
  Inserting a session or token takes `FOR KEY SHARE` on the user row through its foreign key, so
  locking the tenant row first would deadlock against a suspension.

### Password reset and change

- A new path that marks or consumes `password_reset_tokens` either takes the token rows before it
  locks the user row (with a wait), or takes them under the user-row lock without waiting
  (`FOR UPDATE SKIP LOCKED`).
- `changePassword` (`auth/passwordChangeActions.ts`) runs in one READ COMMITTED transaction:
  1. mark every unconsumed token (`consumeAllPasswordResetTokensForUser`);
  2. lock the user row `FOR UPDATE`;
  3. `lockUserTenantBinding`;
  4. compare the hash;
  5. mark the unlocked tokens again (`consumeUnlockedPasswordResetTokensForUser`), and refuse with
     `reauthentication_failed` if any token is still unconsumed;
  6. write the hash, revoke the other sessions, record the attempt.

  It must not raise its isolation level.

### Public auth throttles

- The routes reachable without a session (login, password-reset request and consume, invitation
  acceptance, the mail OAuth callback, the Google and Graph calendar webhooks) are throttled per
  client address in process memory (`createClientIpThrottle` in
  `backend/services/semprec-api/src/clientIpThrottle.ts`, limits in `CLIENT_IP_THROTTLE_LIMITS`). The
  same throttle counts four signed-in actions per user id: mailbox credential verification, a mail
  provider fetch on demand (`mailContentFetch`), a mail search that asks the providers
  (`mailRemoteSearch`) and a native client's IMAP history claim or upload (`mailHistoryUpload`).
- The mail OAuth callback (`mailOauthCallback`) and both calendar webhooks (`calendarWebhook`, one
  budget shared by the two) count every request before any database read; a refused one gets `429`
  with `Retry-After` (an empty body on the webhooks). A Graph calendar batch looks each distinct
  `(subscriptionId, clientState)` pair up once, at most 20 per batch.
- `tryAcquire` reserves a slot before the body is read. Outcomes that must not count release the
  slot. A refused attempt gets `429 rate_limited` with `Retry-After`.
- An IPv4 address is its own key, an IPv4-mapped address counts as its IPv4 address, and any other
  IPv6 address is grouped by its `/64`. At most `maxKeys` keys are held.
- This holds only because there is one `semprec-api` process. A second process needs a new design.
  Addresses come from `clientIpFromRequest`, so the throttle is only as trustworthy as `TRUST_PROXY`.

### Same-origin check

- A request counts as same-origin when it has no `Origin`, or when its `Origin` is an `http:`/`https:`
  URL whose host (lowercase, with port) equals the `Host` header. Forwarding headers are never read.
- `dispatch` (`semprec-api/src/app.ts`, check in `src/originCheck.ts`) answers any method other than
  `GET`/`HEAD`/`OPTIONS` that fails the check with `403 origin_not_allowed` before routing.
- The `WS /api/sync` upgrade refuses a foreign `Origin` with a raw `403` before authentication
  (`src/syncHandler.ts`).
- The check trusts `Host`, so a proxy in front of the API must pass `Host` through.

### Secret links

- A link that carries a secret token puts it in the URL fragment: `/?page=password-reset#token=…`
  (`buildPasswordResetUrl`, `auth/passwordResetActions.ts`) and `/?page=invite#token=…`
  (`tenancy/invites.ts`). The page that reads the fragment clears it with `history.replaceState` on
  mount.
- Tokens are base64url (`auth/token.ts`), single use and expiring. Compare them in constant time.
- The setup wizard's bootstrap `?token=` is the one query-string token.

## Admin plane

### Admin role

- Admin means `users.role = 'admin'`. A route opts in with `admin: true` on its `RouteDefinition`.
  Members get `403 admin_required` after authentication and before the body is read.
  `mountRoutes` (`adapter/routeTable.ts`) throws at startup for an `/api/admin/` path without the
  flag.
- Admin handlers run in `runAsSystem("adminRoute", …)` and read only global tables and router
  aggregates. They never read tenant content, and there is no impersonation. ESLint forbids
  importing `runInTenant` in `adminHandler.ts` and `accountsAdminStore.ts`.
- The one exception is account deletion (`tenancy/deleteAccount.ts`). It enters the target tenant only
  for the deletion transaction and reads no content.
- `admin_audit_log` is append-only for the runtime roles, holds ids and scalars only and has no
  foreign keys. `recordAdminAction` inserts on the mutation's own client. Every admin mutation calls
  it and adds its action to `ADMIN_AUDIT_ACTIONS`.

### Admin membership and tenant status

- After provisioning, only `transitionTenantStatus` (`tenancy/tenantsStore.ts`) changes
  `tenants.status`: a conditional `UPDATE … WHERE id = $1 AND status = ANY($from)`. Zero rows mean
  `409 invalid_account_status`, or `NotFoundError` when the tenant is missing.
- A mutation that can change who counts as an active admin (a role change, or a status change of a
  tenant with an admin) starts with `lockAdminMembership`
  (`pg_advisory_xact_lock(hashtext('semprec_admin_membership'))`), locks the target user row
  `FOR UPDATE`, runs `assertAnotherActiveAdminRemains`, and only then writes. Hot paths never take
  this lock.

## Tenant lifecycle

### Deactivation teardown

- A writer that moves a tenant out of `active` calls `publishTenantDeactivated(client, tenantId)`
  (`tenancy/tenantStatusSignal.ts`) inside the status-changing transaction. It sends a NOTIFY on
  `semprec_tenant_status` with the payload `{"tenantId":"<uuid>"}`. Postgres delivers it only on
  commit. Reactivation publishes nothing.
- `startTenantDeactivationListener` runs `LISTEN` and then reads every `suspended`/`deleting`
  tenant. It does this on the first connect and on every reconnect (backoff 200 ms to 5 s), and it
  buffers notifications that arrive during setup. Consumers are idempotent.
- Every in-memory per-tenant registry (sockets, hosted lifecycles, caches, timers) has an idempotent
  teardown wired to its process's listener, for example `SyncServer.closeTenant` (close code 4401)
  and `MailLiveSyncRoot.stopTenant`.
- A process closes the listener before the components its handler calls, bounded by
  `LISTENER_CLOSE_TIMEOUT_MS`.

### Data export

- `POST /api/account/exports` inserts a `pending` row and enqueues `tenantExport` (`maxAttempts: 1`)
  in one transaction. At most one export per tenant is pending or running.
- `tenancy/tenantExportJob.ts` exports every public table commented
  `semprec:tenancy=tenant`, except `EXPORT_EXCLUDED_TABLES`. A new tenant table holding a server-only
  secret must be added to that list in the same change. Rows are read with
  `to_jsonb(t) WHERE t.tenant_id = app_current_tenant()` through a cursor, inside one
  `repeatable_read` transaction, so every file describes one instant.
- The archive (`formatVersion` 1, written with `yazl`) holds `account.json`, `tables/<t>.jsonl`,
  `blobs/<blobId>` and `manifest.json`, which is written last and includes `missingBlobIds`. It is
  stored at `<tenantId>/exports/<exportId>.zip`.
- On shutdown between entries, the job deletes the partial file, sets the row back to `pending` and
  requeues it. A failure marks the row `failed`. A `ready` export expires after seven days. Then it
  answers the same 404 as an unknown id, and `tenantExportExpirySweep` deletes it.

### Account deletion and purge

- `beginTenantDeletion` moves the tenant to `deleting`, revokes its sessions and push subscriptions,
  deletes its `tenant_keys` row and publishes deactivation.
- `tenantPurge` (`tenancy/tenantPurgeJob.ts`, cron every minute) erases `deleting` tenants. It runs in
  system scope and deliberately works outside the choke point, because nobody can observe the tenant
  any more.
  - It takes a per-tenant session try-lock
    (`pg_try_advisory_lock(hashtextextended('semprec_tenant_purge:' || id, 0))`) on a dedicated
    connection, then re-reads the tenant.
  - Bytes are removed before rows: blob keys from both roots, export files, and the `<root>/<tenantId>`
    directories, again just before finalisation. A failed file deletion blocks finalisation.
  - It purges every table commented `semprec:tenancy=tenant`, children before parents in the
    foreign-key order computed by `orderTablesForPurge` (`tenantPurgeOrder.ts`), so no delete meets a
    key a later table still holds. Deletes run in chunks of 1000, one transaction per chunk, each with
    an explicit `tenant_id = $1` predicate on top of RLS. A row a running writer adds behind the
    order fails a delete or the final check, and the tenant is retried on the next run.
  - Finalisation, in one transaction:
    1. assert that no tenant row remains;
    2. delete the user and its identity rows;
    3. insert the tombstone `tenant_deletions(tenant_id, requested_at, completed_at)`, which holds no
       email or user id;
    4. delete the `tenants` row;
    5. under `LOCK TABLE graphile_worker._private_jobs IN SHARE ROW EXCLUSIVE MODE` with a 2 s lock
       timeout, delete the tenant's idle `_private_job_queues` rows and check that none remain.

    The purge is the only writer of that queue table outside graphile-worker.
  - It checks `helpers.abortSignal` between chunks. When one tenant fails, the purge goes on with the
    others and rethrows the failures together.

### Backup restore

The restore runbook and the monthly restore test are in `deploy/README.md`. The owners are
`tenancy/restoreTenantKeys.ts`, `restorePostgresTools.ts`, `validateRestoreLedger.ts` and
`replayTenantDeletionsCli.ts`.

- Before `pg_restore`, the target cluster gets `semprec_side`, `semprec_data` and `semprec_router` with
  their migration attributes. The production restore keeps owners and privileges and passes
  passwords through `\getenv`, never through argv.
- Services, workers and timers stay offline throughout the restore, key import, ledger validation and
  deletion replay. A single `set -euo pipefail` block starts the units only after everything has
  succeeded. Any refusal (`lastAdmin`, `unexpectedStatus`, validator failure) keeps them offline.
- Key import takes only the newest key dump, which the operator selects explicitly. It never searches
  older snapshots, decrypts or rewraps.
  - Rows are staged into a fresh private database that holds only `tenant_keys`, after a bounded TOC
    check of the dump.
  - The staged rows are validated and then inserted through a non-owner, non-`BYPASSRLS` role under
    `runInTenant`. The insert checks affected rows and never upserts.
  - A key is imported only for a tenant that exists, is not `deleting` and has no tombstone. A key
    missing from the dump means the credential is unavailable.
- Restore tooling owns every exec and connection it starts and never kills by name or pattern. Its
  CLIs print fixed failure lines, never tenant ids, SQL or raw errors.

## Tenant-scoped write paths

### Item links in Markdown

Page insertion and replacement (`docs/pageMarkdown.ts`) call `assertItemLinksExist` after parsing,
on their tenant-scoped write client and before persisting. Malformed, missing, foreign and deleted
targets get the same `ValidationError` on the Markdown field. The shared parser stays pure and has no
database access.

### Trash restore locking

- Trash and restore cascades run the delete and restore hook registries (`chokePoint/hooks.ts`, which
  domains register in `domainWriteHooks.ts`). Hooks run inside the cascade's transaction, and a hook
  that rejects rolls back the whole cascade.
- The epoch is the root's `deleted_at` at full microsecond precision. Restore locks the matching
  subtree rows `FOR UPDATE` in root-first order before it restores any of them. Restore hooks get
  `deletedAtExact` and compare it in SQL, never through a JS `Date`.
- A restore hook that must lock a row which another path locks before the root uses
  `lockItemByIdNowait`. `55P03` propagates and rolls the restore back. It is not retried or mapped.
- Page restore locks the item `FOR UPDATE` and re-checks it before it locks the page's `doc_snapshots`
  row. Never lock an item after its document. An approved replay locks approval request, agent run,
  item, then document. Its staleness token `updateVersion` is the greatest retained update id, read
  in one tenant-scoped statement under the document lock.
