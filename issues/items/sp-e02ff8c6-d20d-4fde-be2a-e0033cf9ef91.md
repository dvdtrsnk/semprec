---
schemaVersion: 1
id: "sp-e02ff8c6-d20d-4fde-be2a-e0033cf9ef91"
title: "[backend-delivery 16/74] Implement architecture, data/auth, realtime changes"
kind: "implementation"
state: "closed"
stateReason: "completed"
labels: ["execution:batch","execution:sequential","spec:approved"]
parent: "sp-62331d42-78af-4b93-ae97-d5ccbe3324df"
assignees: []
milestone: null
createdAt: "2026-10-31T17:31:01.910Z"
updatedAt: "2026-11-03T05:37:51.537Z"
closedAt: "2026-11-03T05:37:51.537Z"
source: null
approval: {"specSha256":"6749f0611085628a702b0ffcab6bd25995d994f5bc2e8323ef86ee367a8e0dc2","source":"repository","actor":"Owner-delegated controller thr_pz39tcih5r: grouped R1 expiry and scoped publication repair","at":"2026-11-03T04:50:55.963Z"}
resolution: {"pullRequests":[],"commit":"ee37aac1813db1773b01b64fdf44999078116493","at":"2026-11-03T05:37:51.537Z"}
---
**Blocked by:** sp-144a2408-c4a8-4b9f-b68b-a5eec527dba7
**Model tier:** high

## Context

Model tier rationale: This delivery combines several existing backend specifications across typed storage, API and runtime boundaries; preserving their contracts and verifying the combined behavior requires cross-module reasoning.

Use one tree and one source writer. Complete the batch before review, acceptance and full verification. Feature epics are reporting groups. Preserve every embedded Task/decision/AC; a member's exclusions limit that member, not another included Task. Implement only their union.

No web/mobile app work, catalogs, builds or tests. Backend device/platform contracts and server tests remain included. UI is context; retain required backend data.

Follow docs/adr/2026-10-31-sequential-backend-delivery-batches.md. Reconcile newer local integration and recovered work with evidence/handovers rather than rebuilding. Dispatch is not completion.

This exact specification is approved for owner-delegated backend execution at dispatch. Follow `issues/batches/backend/decisions/batch-16-spec-reconciliation.md`; approval applies only to the recorded current hashes and does not waive review, runtime gates or completion guards.

Execution order: gh-1395 → gh-1362 → gh-1557 → gh-1354 → gh-1512 → gh-1373 → gh-1393 → gh-1382 → gh-1416 → gh-1428. Internal prerequisites are included earlier in this order; prerequisites assigned to previous batches must have passed their gates first. Preserve declared source dependencies; no shared-file dependency has been discarded.

## Task

Implement these exact snapshots in order with their required skills and tests. Bind every source Task/AC to production entry point, SHA, scenario, log and verdict. Use targeted development checks, then independent review and the full backend gate.

### Requirement gh-1395: [semp-threads 03/19] Publish Semp thread invalidations over realtime

#### Context

Model tier rationale: A new invalidation scope added to an existing thin-message realtime mechanism, with the one non-trivial part being that writes from the agents process must reach the API's sockets.

Realtime in `backend/packages/realtime` uses thin messages through `semprec_events` (`pgNotifyPublisher.ts`): outbound frames `invalidate` for `item` and `schema`, `notification`, `agent:event` and `agent:delta`. The app has no way to learn that a Semp thread changed (a new message, a reply changing state, a title change, a tick run) except by polling. Live reply text already flows through `agent:watch {runId, afterEventId}`; only the thread-level change signal is missing.

#1367 added the tables. #1383 makes realtime messages publishable from `semprec-agents`, where the turn runner and heartbeat runs write thread rows. This issue adds the `sempThread` invalidation scope and its publishing hook; the code paths that write messages call it from their own issues.

Client-side phases of a reply are derived from existing events (queued or turn start = thinking, tool_use name = i18n description, first text delta = writing); no new server event is needed.

Builds on this: #1727, #1557, #1789 and #1863 publish through it.

Decision: delivery is best effort, to sockets of the tenant only, with no replay; the client refetches the thread on reconnect.

#### Task

Load `state-writes`, `io-hardening`, `canonical-keys` and `testing`.

1. In `backend/packages/realtime/src/protocolV1.ts` add the message `{ type: 'invalidation', scope: 'sempThread', threadId }` to `RealtimeMessage` and the outbound frame `{ type: 'invalidate', scope: 'sempThread', threadId }` to `OutboundFrame`. Update `pgNotifyPublisher.ts` (publish and parse) and `syncServer.ts` fan-out so only sockets of the message's tenant receive it. Follow the accepted tenant-scoped fan-out ADR: PostgreSQL derives the envelope tenant from publisher scope, with no explicit publisher tenant override; keep the existing session-revocation exception.
2. Update `backend/packages/realtime-client` (`serverFrame.ts` and its exports) to parse and expose the new frame.
3. Add a data-layer hook in `backend/packages/data/src/realtimeHook.ts` (a `publishSempThreadInvalidation(client, tenantId, threadId)` shape) that publishes after commit through the existing after-commit mechanism (`runAfterCommit`), usable from both `semprec-api` and `semprec-agents` hooks.
4. Tests: a socket of tenant A receives the frame, a socket of tenant B does not; the frame is not published when the transaction rolls back; a hook call in a `semprec-agents` style write reaches an API socket through `semprec_events`; the client parses the frame; malformed frames are ignored.

#### Touches

- backend/packages/realtime/src/protocolV1.ts
- backend/packages/realtime/src/pgNotifyPublisher.ts
- backend/packages/realtime/src/syncServer.ts
- backend/packages/realtime/src/wireHooks.ts (only if hooks are wired there)
- backend/packages/data/src/realtimeHook.ts
- backend/packages/realtime-client/src/serverFrame.ts
- backend/packages/realtime-client/src/index.ts (export line, if any)
- tests beside each of the above
- backend/services/semprec-api/src/__tests__/tenantIsolationRealtime.test.ts (only actual API sempThread hook/publisher delivery, runtime-role tenant isolation and rollback evidence)
- backend/services/semprec-agents/src/__tests__/realtimeWiring.test.ts (only replace the existing schema-sentinel explicit publisher tenant argument with runInTenant for that tenant, preserving its assertions and lifecycle)

#### Scope

##### In scope

- The `sempThread` scope in the protocol, publisher, server fan-out, client parser and the after-commit publish hook.

##### Out of scope

- Calling the hook from message writes: #1620, #1727.
- Calling it for tick runs: #1557.
- Invalidations for approval requests and agent runs: #1789, #1863.
- Replay of missed invalidations.

#### Acceptance criteria

- When the hook runs for a thread of tenant A, then only sockets of tenant A receive an `invalidate` frame with scope `sempThread` and that thread id.
- When the surrounding transaction rolls back, then no frame is sent.
- When the hook is called from the agents process, then the frame still reaches the client.
- The client library parses the new frame and ignores malformed ones.

### Requirement gh-1362: [collection-schema 02/14] Acknowledge persisted doc updates over sync

#### Context

Model tier rationale: One additive protocol extension (an optional trailing field on update frames and one new outbound frame) implemented in the sync server and mirrored in the client parser, with the commit-before-ack ordering and the drop paths covered by the existing doc-sync test harness.

A page editor shows "Saving..." while an edit travels to the server and "Synchronized" once the server has stored it. Today the client cannot know that: updates travel over `WS /api/sync` as binary frames made of a 16-byte document id and a y-protocols payload (`backend/packages/realtime/src/protocolV1.ts`, `DOC_FRAME_PREFIX_BYTES`); the payload carries no correlation id, the stored row (`doc_updates.id`) is a server-side bigserial the client never learns, and the server sends nothing back to the author. `handleBinaryFrame` in `backend/packages/realtime/src/docSync.ts` applies a SyncStep2 or Update message through `mutateYDoc` (`backend/packages/data/src/docs/docPersistence.ts`), whose transaction commits before the promise resolves, and then fans the change out to subscribers by NOTIFY; the author gets no confirmation. A frame is silently dropped when the socket has not opened the document under its tenant, when the per-socket rate limit is exceeded, or when the payload is malformed.

This issue adds an acknowledgement for a persisted update. For item properties the PATCH response is already the acknowledgement, so this concerns page content only.

The protocol file is also edited by the invalidation-scope additions of #1621 and #1625; this issue touches different declarations in it (the inbound update payload helpers and a new outbound frame type, not the `invalidate` frame variants), so the changes do not overlap in a way that needs ordering.

Decision: the client correlation id travels as an optional trailing `varString` appended after the update bytes inside the existing y-protocols payload (`messageYjsSyncStep2` or `messageYjsUpdate`), so a server that does not know it ignores the extra bytes and an old client that sends none behaves exactly as today. A valid id is 1 to 64 characters of `[A-Za-z0-9_-]`; a missing, malformed or over-long id means "no id": the update is still persisted but never acknowledged.

Decision: the acknowledgement is a text frame `{ type: "doc:ack", docId, clientUpdateId }` sent only to the socket that sent the update, after `mutateYDoc` has resolved. It is also sent when the update added nothing new (a replay or an already-known update), because its content is durable and the client would otherwise show "Saving..." forever.

#### Task

Load `io-hardening`, `error-handling` and `testing`.

1. In `protocolV1.ts` add the `doc:ack` variant to `OutboundFrame` (`{ type: "doc:ack"; docId: string; clientUpdateId: string }`), a constant for the id limits with an `isClientUpdateId` guard, and two helpers: `appendClientUpdateId(payload, clientUpdateId)` (for clients and tests; writes the trailing `varString`) and `readClientUpdateId(decoder)` (returns the id when the decoder has remaining content and the value is valid, otherwise `null`, never throwing).
2. In `docSync.ts` `handleBinaryFrame`, for SyncStep2 and Update messages read the optional id after the update bytes; after the `mutateYDoc` call resolves, if an id was present and the socket is still open, send the `doc:ack` text frame to that socket with `sendWithBackpressure`. No ack for a frame that is dropped before persistence (document not open under the socket's tenant, rate-limited, malformed) or when `mutateYDoc` throws. SyncStep1 handling is unchanged.
3. In `backend/packages/realtime-client/src/serverFrame.ts` add `doc:ack` to `parseServerFrame` with field validation, and in `syncClient.ts` dispatch it to a new optional `onDocAck(docId, clientUpdateId)` option. Generating ids for local edits and the "Saving..." indicator are client work and not part of this issue.
4. Tests: in `backend/packages/realtime/src/__tests__/protocolV1.unit.test.ts` the helper round trip and the invalid-id cases; in `docSync.test.ts` an ack arrives only after the update is readable from `doc_updates`, a replayed update is acknowledged, an update with no id and one with a malformed id are persisted without an ack, frames for an unopened document, for another tenant's document and over the rate limit get no ack and (for the first two) no write, an ack goes to the sender and not to other subscribers; in the client package tests the `doc:ack` frame is parsed and dispatched and a malformed one is dropped.

#### Touches

- backend/packages/realtime/src/protocolV1.ts (OutboundFrame doc:ack variant, client update id helpers)
- backend/packages/realtime/src/docSync.ts (handleBinaryFrame)
- backend/packages/realtime-client/src/serverFrame.ts (parse doc:ack)
- backend/packages/realtime-client/src/syncClient.ts (dispatch to onDocAck)
- backend/packages/realtime/src/__tests__/protocolV1.unit.test.ts
- backend/packages/realtime/src/__tests__/docSync.test.ts
- backend/packages/realtime-client/src/__tests__ (parser and dispatch tests)

#### Scope

##### In scope

- The optional client update id on update frames, the `doc:ack` frame, its sending after commit to the author only, and the client library's parsing and callback.

##### Out of scope

- Generating ids for local edits, the "Saving..." and "Synchronized" indicator, and retrying unacknowledged updates (client work).
- Acknowledgements for item property edits (the PATCH response is the acknowledgement).
- Page summary, `docId` lookup and page creation: #1615 and #1616.
- Last-edit tracking: #1405; thin document invalidations: #1625.
- Reporting what the assistant changed on a page: #1680.

#### Acceptance criteria

- When a subscribed client sends an Update frame carrying a valid `clientUpdateId`, it receives `doc:ack` with its `docId` and that id, and at that moment the update is already stored (reading the document through the persistence layer returns it).
- Other sockets subscribed to the same document do not receive the `doc:ack`; they receive the update through the existing fan-out.
- An update frame without an id, or with an id longer than 64 characters or containing other characters, is persisted exactly as before and produces no ack.
- A frame for a document the socket has not opened under its tenant, or one dropped by the rate limit, produces no ack; when the server fails to persist, no ack is sent.
- Replaying the same update with the same id is acknowledged again without storing a second row.
- A client library built before this change keeps working against the new server, and the new server keeps accepting updates from it.

### Requirement gh-1557: [ticks 05/11] Write heartbeat agent runs into their tick thread

#### Context

Model tier rationale: One write path inside an existing action, with an atomic upsert and one transaction, over tables and realtime publishing delivered by blockers; the fixtures for agent runs already exist.

A tick is a scheduled automation of a project (a heartbeat, stored in `project_heartbeats`). Today each firing of a heartbeat whose action is `core.agentRun` creates its own agent run: `coreAgentRunAction` in `backend/packages/data/src/scheduler/actions.ts` calls `createAgentRun` (`triggeredBy: 'heartbeat'`, `heartbeatId`, `parentRunId` of the triggering run), runs the agent, and finishes the run with `finishAgentRun(pool, ...)` outside any transaction. Every attempt is a new run; only the last attempt of a failed occurrence closes with an error notification. The result lives in `agent_runs.result` and nowhere a person can read as a conversation.

The product wants one Semp thread per automation, where every run appears as a section (start time, summary, result, footer). The thread tables are created by #1367 and agent runs are linked to threads by #1452; realtime frames from the agents service by #1383, and thread invalidation frames by #1395. This issue writes each heartbeat run into its tick thread. The header and active run (#1562), run timing and status per message (#1563) and follow-up turns (#1731) build on it; the typed step summary (#1860) and the reply error codes (#1907) fill fields this issue leaves empty.

Decision: only heartbeats whose action is `core.agentRun` get a thread; other actions (for example a deterministic sweep) have no thread and no agent run.

#### Task

Load `state-writes`, `error-handling`, `io-hardening` and `testing`.

1. Verify the existing partial unique index on `semp_threads (tenant_id, heartbeat_id) WHERE kind = 'tick'`, the `heartbeat_id` column, tenant, RLS and grants supplied by #1367 in `0087_semp_threads_and_messages.sql`. Preserve that historical migration; do not add a redundant index or migration solely to repeat it. If a genuinely missing requirement needs an additive corrective migration, propose its exact scope to the controller first.
2. In `coreAgentRunAction`, before running the agent, lazily get-or-create the tick thread with `INSERT ... ON CONFLICT (tenant_id, heartbeat_id) WHERE kind = 'tick' DO UPDATE SET last_activity_at = now() RETURNING id` (a `DO NOTHING` form would not return the id of the existing row). Set `agent_runs.thread_id` on the created run.
3. On success, in one `withTransaction`: `finishAgentRun` to `done` and insert the assistant message with `text` = the run result, `agent_run_id`, `event_from_id` = the first and `event_to_id` = the last event of the run. Either both writes happen or neither. A pending approval request created by the run does not change this: the run is `done` and the request link is carried by the steps field filled by #1860.
4. On error, write the assistant message with status `error` and an error code only for the final attempt of the occurrence (`context.isFinalAttempt !== false`); a non-final attempt writes no message. The code values are filled by #1907; until then store the field empty.
5. Publish a thread invalidation (`sempThread`) at run start and at run end using the publisher from #1395.
6. Tests: three runs of one heartbeat produce three messages in one thread; a heartbeat whose action is not `core.agentRun` creates no thread; an occurrence with several attempts whose last fails writes exactly one error message; failing the message insert leaves the run unfinished (rolled back together).

#### Touches

- backend/packages/data/src/db/migrations/0087_semp_threads_and_messages.sql (existing dependency schema: verify without rewriting)
- backend/packages/data/src/__tests__/migrationCompatibility.test.ts (only actual staged tick-thread schema upgrade, populated legacy preservation and unique-index constraints)
- backend/packages/data/src/scheduler/actions.ts
- backend/packages/data/src/agentRuns/agentRunsStore.ts (set `thread_id`)
- backend/packages/data/src/ (new thread store functions next to the thread store from #1367)
- backend/packages/data/src/__tests__/ (new tests)

#### Scope

##### In scope

- Lazy tick thread, linking runs to it, the transactional message write, the final-attempt error message and the invalidations.

##### Out of scope

- Thread and message tables: #1367. Linking runs to threads in general: #1452.
- Typed step summaries and approval links in steps: #1860.
- Reply error classification: #1907.
- The thread header and the active run: #1562. Run timing per message: #1563.
- Follow-up questions in the tick thread: #1731.

#### Acceptance criteria

- Three runs of one heartbeat result in three assistant messages in one tick thread; a heartbeat without `core.agentRun` has no thread.
- An occurrence with several attempts where the last fails writes one error message and no message for earlier attempts.
- `finishAgentRun` and the message insert commit together or not at all.
- Starting and finishing a run publishes a `sempThread` invalidation.

### Requirement gh-1354: [account 01/15] Record the device identity of a session at login

#### Context

Model tier rationale: One known mechanism (a nullable-column migration on the identity plane plus validated login input and a user-agent matcher) across the store, action and handler seams with existing login fixtures, and no change to who can authenticate.

The app is going to show the signed-in devices of an account ("this iPhone", "Safari on macOS", "iPad Air") and let the user sign individual devices out. Today a session cannot say which device it belongs to. `POST /api/auth/login` (`backend/services/semprec-api/src/authHandler.ts`, `login` in `backend/packages/data/src/auth/authActions.ts`) stores only `platform` (`web|ios|macos`) and the `User-Agent` header in the `sessions` table (`0025_auth_schema.sql`). `SessionRow`, `SessionDbRow`, `mapRow` and `createSession` live in `backend/packages/data/src/auth/sessionsStore.ts` and `backend/packages/data/src/auth/types.ts`. `sessions` is a global identity table: only `semprec_data` has DML on it (`0057_identity_tables_api_role_only.sql`), so a new column needs no new grant.

This issue only records the device identity at login. Sliding expiry (#1512), listing (#1583), bulk revocation (#1650) and replacing a previous session of the same installation (#1687) build on the columns added here.

Decisions:
- Device fields sent by a web login are ignored (not rejected); the server derives them from the `User-Agent` header, because a browser must not be able to claim to be an iPhone. `deviceId` is stored only for `ios` and `macos` logins.
- `osVersion` and `appVersion` are trimmed strings of 1-50 characters; `deviceName` is a trimmed string of 1-100 characters.
- All device fields stay optional for native logins, so an older client keeps logging in; its sessions simply have `NULL` device columns.

#### Task

Load `db-migrations`, `error-handling`, `io-hardening` and `testing`.

1. Add the migration `backend/packages/data/src/db/migrations/NNNN_session_device_identity.sql` (next free ordinal at commit time): `ALTER TABLE sessions ADD COLUMN device_id uuid, ADD COLUMN device_name text, ADD COLUMN device_kind text, ADD COLUMN os_version text, ADD COLUMN app_version text`, all nullable, with `CHECK (device_kind IN ('iphone','ipad','mac','browser'))` (NULL allowed), and a partial index `sessions_user_device_active_idx ON sessions (user_id, device_id) WHERE revoked_at IS NULL`.
2. Add `SESSION_DEVICE_KINDS = ["iphone","ipad","mac","browser"]` and a `SessionDeviceKind` type to `auth/types.ts`; extend `SessionRow` with `deviceId`, `deviceName`, `deviceKind`, `osVersion`, `appVersion` (each `string | null`), and extend `SessionDbRow`, `SELECT_COLUMNS`, `mapRow` (validate `device_kind` with `assertKnownValue`) and `CreateSessionInput`/`createSession` in `sessionsStore.ts`.
3. Add a small pure matcher `backend/packages/data/src/auth/userAgentDevice.ts` (no new dependency) that turns a `User-Agent` string into `{ deviceName, osVersion }` for web logins: browser `Safari|Chrome|Firefox|Edge` else `Other`; OS family `macOS|iOS|Windows|Linux|Android` else `null`. Order matters (Edge before Chrome before Safari; iOS and Android before macOS and Linux).
4. In `authHandler.ts` login: read optional `deviceId`, `deviceName`, `deviceKind`, `osVersion`, `appVersion` from the body. For `ios`/`macos`: `deviceId` must be a UUID, `deviceName`/`osVersion`/`appVersion` must be strings within the limits above, `deviceKind` must be `iphone|ipad` for `ios` and `mac` for `macos`; any violation is a 400 `validation_failed` with `details.field` naming the field. For `web`: ignore them and set `device_kind = 'browser'` with `deviceName`/`osVersion` from the matcher. Pass the result to `login` (new optional `device` on `LoginInput`) and on to `createSession`.
5. Add tests: migration/column presence and constraint in `authSchema.test.ts`, login persistence and rejection cases in `authActions.test.ts` and `authHandler.test.ts`, and unit tests for the matcher.

#### Touches

- backend/packages/data/src/db/migrations/NNNN_session_device_identity.sql (next free ordinal at commit time)
- backend/packages/data/src/auth/types.ts (session device kinds, `SessionRow`)
- backend/packages/data/src/auth/sessionsStore.ts (row type, columns, `createSession`)
- backend/packages/data/src/auth/userAgentDevice.ts (new)
- backend/packages/data/src/auth/authActions.ts (`LoginInput`, passing the device to `createSession`)
- backend/packages/data/src/index.ts (barrel export of the new module)
- backend/packages/data/src/__tests__/publicSurface.test.ts (new export names)
- backend/packages/data/src/__tests__/userAgentDevice.unit.test.ts (the required pure matcher tests)
- backend/packages/data/src/__tests__/migrationCompatibility.test.ts (only actual staged session-device upgrade, populated legacy preservation and new constraints)
- backend/packages/data/src/__tests__/authSchema.test.ts
- backend/packages/data/src/__tests__/authActions.test.ts
- backend/services/semprec-api/src/authHandler.ts (login body parsing)
- backend/services/semprec-api/src/__tests__/authHandler.test.ts

#### Scope

##### In scope

- The five nullable columns, the partial index, and persisting validated device fields at login.
- Server-side derivation of the web device name and OS family from the `User-Agent` header.

##### Out of scope

- Any response that returns the device fields: listing is #1583; `GET /api/auth/session` is unchanged.
- Changing session expiry: #1512.
- Revoking a previous session of the same `deviceId`: #1687.
- Backfilling device fields on existing sessions.

#### Acceptance criteria

- When an `ios` login sends `deviceName` "iPhone 17 Pro", `deviceKind` `iphone`, a UUID `deviceId`, `osVersion` and `appVersion`, then the session row stores all five.
- When a login sends `deviceKind` "phone", or `platform` `ios` with `deviceKind` `mac`, or a `deviceId` that is not a UUID, then the response is 400 `validation_failed` with the offending field in `details.field` and no session is created.
- When a `web` login carries a Safari-on-macOS `User-Agent`, then the session stores `device_kind` `browser`, `device_name` `Safari`, `os_version` `macOS`; device fields in the body are ignored.
- When a native login sends no device fields, then it succeeds and the five columns are `NULL`.
- An insert with `device_kind` outside the four values fails the database check.

### Requirement gh-1512: [account 08/15] Slide session expiry while the session is used

#### Context

Model tier rationale: A single SQL statement and one TTL policy change on the authentication path, but it alters how long a credential lives, so the 401-after-idle and ceiling behaviors need tests against the real session lookup.

A session now lives a fixed 30 days from login (`SESSION_TTL_SECONDS` in `backend/packages/data/src/auth/authActions.ts`). `verifySessionToken` calls `touchSessionLastSeen` (`backend/packages/data/src/auth/sessionsStore.ts`) on every authenticated request, but that only moves `last_seen_at`; `expires_at` never moves. A phone that is used daily is therefore signed out after 30 days, although the signed-in devices list is meant to show devices that stay signed in for months.

This issue makes expiry sliding: each authenticated request pushes `expires_at` forward by an idle window that depends on the platform, bounded by an absolute ceiling. It builds on the `platform` and `created_at` columns that exist today and follows #1354 because both edit `sessionsStore.ts`. #1583 lists sessions that this rule keeps alive.

Decisions (decided by the product owner as sufficient for v1; the values are server-side configuration, never set by the user):
- Idle window: 90 days for `ios` and `macos`, 30 days for `web`.
- Absolute ceiling: 365 days after `created_at`, for every platform.

#### Task

Load `state-writes` and `testing`.

1. In `authActions.ts` replace the single TTL with `SESSION_IDLE_TTL_SECONDS_BY_PLATFORM` (`ios` and `macos` 90 days, `web` 30 days) and `SESSION_MAX_LIFETIME_SECONDS` (365 days). Keep `SESSION_TTL_SECONDS` exported only if still needed by the cookie helper below; otherwise remove it and update the frozen export list in `publicSurface.test.ts`. `login` computes the initial `expiresAt` from the platform idle window.
2. In `sessionsStore.ts` change `touchSessionLastSeen` to one `UPDATE` that sets `last_seen_at = now()` and `expires_at = LEAST(created_at + interval '365 days', GREATEST(expires_at, now() + <idle window by platform>))`. The idle window is chosen in SQL from the row's `platform` (or passed as a parameter derived from the already-loaded session); the expiry never passes the ceiling and never moves backwards when the existing expiry is at or below that ceiling. An existing expiry above the ceiling is clamped downward; this defensive case does not establish historical production data.
3. In `authHandler.ts` set the web session cookie `Max-Age` to the ceiling (`SESSION_MAX_LIFETIME_SECONDS`); idleness is enforced by the server through `expires_at`, not by the cookie.
4. Add tests: a native session touched once has `expires_at` about 90 days ahead; a web session about 30 days; a session whose `created_at` is 364 days old gets `expires_at` capped at `created_at + 365 days`; a session untouched for longer than its idle window gets 401; `expires_at` never decreases for a row already at or below its ceiling; a synthetic above-ceiling row is clamped. Include an active web session before its cap threshold and one at its cap threshold.

#### Touches

- backend/packages/data/src/auth/authActions.ts (TTL constants, initial `expiresAt` in `login`)
- backend/packages/data/src/auth/sessionsStore.ts (`touchSessionLastSeen`)
- backend/services/semprec-api/src/authHandler.ts (cookie `Max-Age`)
- backend/packages/data/src/__tests__/publicSurface.test.ts (only if an exported constant is added or removed)
- backend/packages/data/src/__tests__/authActions.test.ts
- backend/services/semprec-api/src/__tests__/authHandler.test.ts

#### Scope

##### In scope

- Platform-dependent idle expiry that slides on use, the 365-day ceiling, the initial expiry at login, and the web cookie lifetime.

##### Out of scope

- Returning `expiresAt` to clients or changing any response body.
- Listing sessions: #1583.
- Revocation behavior and push registrations: #1650, #1687.
- Any scheduled cleanup of expired session rows.

#### Acceptance criteria

- When an `ios` session makes an authenticated request, then its `expires_at` is about 90 days after now; for a `web` session about 30 days.
- When a session has been unused for longer than its idle window, then its token gets 401.
- On use, `expires_at` equals `created_at + 365 days` when the later of its existing expiry and now plus its platform idle window reaches that ceiling; it is never later. Native 90-day windows reach the age threshold at 275 days, web 30-day windows at 335 days; age 275 alone does not cap web sessions.
- A request never moves `expires_at` earlier if it was already at or below `created_at + 365 days`. An above-ceiling expiry is clamped to the ceiling, preserving the exact Task 2 formula.
- A web login sets a cookie whose `Max-Age` is 365 days.

### Requirement gh-1373: [approvals 02/20] Answer the MCP initialize handshake on POST /mcp

#### Context

Model tier rationale: One protocol change in a single handler with a small, well-specified request/response contract, but it sits on an authenticated endpoint where the unauthenticated and tenant behavior must stay unchanged.

The MCP endpoint `POST /mcp` (`backend/services/semprec-api/src/mcp/mcpHandler.ts`) serves only `tools/list` and `tools/call`. Any other JSON-RPC method, including `initialize`, answers `-32601 Unknown method`, so a standard MCP client cannot complete its handshake, and every non-POST request answers 404. The handler authenticates first (a run credential or a human session/Bearer, then the tenant scope); that order stays.

This issue answers the handshake so standard clients can connect. #1788 builds on it by recording the client name sent in `initialize`.

Decision: the supported protocol versions are `2025-06-18`, `2025-03-26` and `2024-11-05`; `initialize` echoes the client's `protocolVersion` when it is one of these, and otherwise answers the newest (`2025-06-18`). Decision: the server version in `serverInfo` is the API service's package version.

#### Task

Load `io-hardening` and `testing`.

1. Handle `initialize` in `createMcpRequestListener`, after authentication and inside the tenant scope like the other methods: result `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "semprec", version } }`. `params` that are missing or malformed answer `-32602` (the same shape as invalid tool arguments).
2. A JSON-RPC notification (no `id`), such as `notifications/initialized`, answers HTTP 202 with an empty body and nothing else; this applies to any notification method.
3. A `GET` (and any non-POST method) on `/mcp` answers 405 with `Allow: POST`. `tools/list` and `tools/call` are unchanged.
4. `initialize` persists no domain or handshake/client data and exposes no other tenant/user data; human and run-credential responses are identical. Preserve #1512 authentication: only the caller session's normal `last_seen_at`/`expires_at` touch is allowed, with no new run-credential write.

#### Touches

- backend/services/semprec-api/src/mcp/mcpHandler.ts
- backend/services/semprec-api/src/__tests__ (mcp handler tests)
- backend/services/semprec-api/src/mcp/__tests__/mcpHandler.test.ts (existing protocol harness, including actual human-session/run-credential initialize equivalence and persistence assertions)

#### Scope

##### In scope

- `initialize`, notification handling with 202, and the 405 for non-POST.

##### Out of scope

- Recording the client name from `initialize` params: #1788.
- Other MCP methods (resources, prompts, ping).
- Whether calls made with a human session pass through approvals: a product decision that remains open; behavior is unchanged here.
- Streamable HTTP server-to-client streaming.

#### Acceptance criteria

- `initialize` with a supported `protocolVersion` returns that version, `capabilities: { tools: {} }` and `serverInfo.name = "semprec"`; an unsupported version returns `2025-06-18`.
- `notifications/initialized` returns 202 with no body, and a following `tools/list` returns the same tools as before.
- `GET /mcp` returns 405 with `Allow: POST`.
- An unauthenticated `initialize` is rejected exactly as an unauthenticated `tools/list` is.
- Human-session `initialize` succeeds without domain or handshake/client persistence. Only its normal `last_seen_at`/`expires_at` touch is allowed; other session fields/rows and relevant domain rows stay unchanged. Compare contents, not counts alone. Run-credential initialize has the same response, no session touch and no handshake persistence.

### Requirement gh-1393: [subpages 01/12] Record where subpages live in an ADR

#### Context

Model tier rationale: The change is a decision document with no code, but it fixes the storage, addressing and lifecycle contract that nine later issues implement, so a gap here propagates into data that is hard to migrate.

A page can contain subpages: a block of type `page` that is a page of its own, nested without a fixed depth (a project note holds "Release checklist", which holds "Notes for version 0.4"). Semprec has no place for such a page today. The Yjs document of an item is the only page storage (`docs`, with `docs.item_id` NOT NULL and at most one document per item, `0003_docs.sql`), so a standalone page needs an item of its own. Breadcrumbs come from `getItemPath` (`backend/packages/data/src/chokePoint/itemReads.ts`), which follows `databases.parent_item_id` and stops at the first repeated database, so it cannot walk a chain of items that live in one database. An inline database under every parent would add an items partition and a write to the shared `databases` table for each page that has a subpage, and the partition attach waits for other tenants' writes to that table (decision record `2026-10-08-items-partitions-attached-under-share-update-exclusive`). The sync socket allows at most 32 open documents per connection (`backend/packages/realtime/src/docSync.ts`). A custom module route may not be CRUD over module data (`backend/packages/module-registry/src/manifest.ts`, decision record `2026-09-11-module-manifest-custom-routes`).

This issue records where subpages live. The page operations are implemented by #1676, #1722, #1725 and #1715; deletion, restore and orphan handling by #1723, #1763, #1855 and #1749; the delete impact preview (#1856) and the proposal options (#1959) build on the same model. It builds on the block-model decision of #1366 and the page operation family of #1394.

Decisions to record (each with the rejected alternative and the trade-off):
- Storage: one hidden system database `pages` per tenant (owner module id `pages`, declared in the docs module manifest with no overview or switcher order, so it is never shown as a collection), created on first use under an advisory lock rather than by the seed, so no tenant backfill is needed. Each subpage is one item of it, with a document of kind `page`; the page's id is the item id and its address is `semprec://page/<itemId>`.
- Parent link: the system-owned text property `parentItemId` on the Pages item points to the host item or parent page; breadcrumbs walk that property. Rejected: a relation property (edge hooks and cardinality triggers for no gain), inline databases per parent (partition and shared-table lock per page), and a subtree of blocks inside one document (the sync socket would open the whole tree, trash and search would work inside one document, and a link would be a block id only).
- Page block: type `page` with `pageId` (the Pages item id) and `text` holding the title as plain text without inline attributes. This amends the block-model decision, which gave `page` blocks no text: the title is the text of the block in the parent, because the editor edits it there.
- Title source: the block text in the parent document is the source of truth. The `title` property of the Pages item is a mirror, written by `page.rename` and by a post-commit job after a parent document changes; trash, export, item reads, search and breadcrumbs read the mirror and never load the parent document.
- Lifecycle: creation, duplication and renaming are page operations of the generic catalog; there is no CRUD route for pages. Deleting a page is the generic item delete and restore with domain hooks, so an agent's delete still needs approval; a deleted host trashes its subpages through the same hooks; a block removed directly through the sync socket leaves an orphan that a sweep trashes.
- Hosts: only full editors can hold subpages (project notes, Journal days and periods, areas, events, pages of items, subpages); light editors reject `page` blocks.
- Limits: depth is not limited, a page can never be its own ancestor, and duplication is capped (see #1722).

#### Task

Load `adr-conventions`. Reconcile the existing accepted ADR below; no code and no duplicate ADR. Follow batch-16-spec-reconciliation.md section 1.

1. Verify `docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md`, already created and accepted, with the frontmatter and sections of `docs/adr/README.md`, area `backend`. It must record every decision above with alternatives and consequences, and must not contradict `2026-09-10-single-writer-ownership-model.md`. Preserve its creation date, permanent path and accepted body; a missing material decision requires an append-only corrective ADR proposed to the controller.
2. Verify the explicit amendment in Decision 3 of the existing subpages ADR: `page` blocks carry the title as plain `text`. The historical block-model ADR `2026-10-28-block-model-for-page-documents.md` remains byte-identical, including its body and frontmatter; do not add a retrospective note to it.

#### Touches

- docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md (existing accepted decision: reconcile without rewriting; any missing material decision needs controller-approved append-only correction)

#### Scope

##### In scope

- The existing accepted subpages ADR and its explicit amendment of the block-model contract, preserving the historical block-model ADR unchanged.

##### Out of scope

- Any code, schema, route or operation: #1676 onward.
- The page operation family and its capability classes: #1394.
- Agent classification of page operations: #1844.

#### Acceptance criteria

- The ADR exists with valid frontmatter, links no external specification, and states for storage, parent link, page block shape, title source, lifecycle, hosts and limits the chosen option and the rejected one.
- It states that the hidden database is created on first use and is never shown as a collection.
- Decision 3 of the subpages ADR explicitly amends the page-block text contract; the historical block-model ADR remains byte-identical.
- No source file is changed.

### Requirement gh-1382: [inbox-cards 01/10] Record in an ADR that confirming an MCP card only pre-fills project grants

#### Context

Model tier rationale: The deliverable is an authorization decision (who may grant a project access to external tools) that later code must follow literally, so a wrong or loosely worded rule is expensive; it needs care even though no code changes.

The Inbox can propose connecting an MCP server and the user confirms it together with a key. The card also lets the user say which projects should use the server. Today the codebase forbids any grant write outside the project's AGENT page: `project_mcp_grants` (default `granted = false`) can be written only by `setProjectMcpGrant` in `backend/packages/data/src/mcp/mcpGrantsAdminStore.ts`, which is kept off the public surface of `@semprec/data`, and the header of `backend/packages/data/src/mcp/mcpProjectGrantsStore.ts` records that "agents, including proposal confirmation, have no write path to grants". The only human path is `PATCH /api/projects/:projectItemId/mcp-grants/:mcpToolRegistrationId` on a project's AGENT page (`backend/services/semprec-api/src/mcpAgentPageHandler.ts`), whose list (`GET /api/projects/:projectItemId/mcp-grants`) already returns each tool's `riskClass`. Grants also only become possible after a sync has registered the server's tools (#1976 runs it after the confirm). The code comments alone are not an ADR, so the stance needs to be recorded as a decision.

Relevant accepted decisions to read and cite where they apply: `docs/adr/2026-09-18-restricted-mcp-run-credentials-for-approval-gated-calls.md`, `docs/adr/2026-09-18-non-destructive-generic-operations-bypass-agent-approval.md`, `docs/adr/2026-10-16-stdio-mcp-confined-to-admin-tenants.md`, `docs/adr/2026-09-10-agent-writes-are-proposals-not-direct-writes.md` and `docs/adr/2026-09-10-single-writer-ownership-model.md`.

Decision (made by the product owner, to be recorded in the ADR): confirming an MCP server card never grants project access to the server's tools. The project selection on the card only pre-fills a suggestion: the server's tools of risk class `read` are pre-selected for the chosen projects, and the user grants them explicitly in the project's permissions (the AGENT page route above). Reason: even a read-class tool sends the project's data to a third party, so every grant must be an explicit act of the user on the grant itself, not a side effect of confirming a card.

Consequences the ADR states:

- no confirm route, proposal envelope, agent tool, `/mcp` operation, run credential, heartbeat or queue job (including the post-confirm sync of #1976) writes `project_mcp_grants`; the AGENT page route stays the only writer;
- the pre-fill is a client concern built from data the AGENT page list already returns (`riskClass`), so the confirm body and the sync job carry no grant selection;
- tools added by later syncs are not granted either; they appear ungranted on the AGENT page;
- `requires_approval` and the risk classes (the closed set of #1423) are unchanged.

#### Task

Load `adr-conventions`.

1. Add `docs/adr/YYYY-MM-DD-mcp-card-confirm-only-prefills-project-grants.md` (the date of the day it is created; frontmatter per `docs/adr/README.md`, `area: [backend]`). Sections: Context (the current rule and why it existed), Decision (the confirm never writes grants; the card only pre-fills read-class tools for the chosen projects; the user grants on the AGENT page; the reason above), Consequences (the list above), Alternatives considered (a human confirm grants read and write tools under limits; a confirm grants read-class tools only; grant at sync time without a human), each with why it was rejected.
2. State that the decision confirms the existing rule in the header comment of `mcpProjectGrantsStore.ts` and refer to it by file, without editing the older documents.
3. Name the invariant later code must keep testing: no path other than the AGENT page route can write a grant, in particular not the confirm route, the post-confirm sync job, agent tools or `/mcp`.

#### Touches

- docs/adr/YYYY-MM-DD-mcp-card-confirm-only-prefills-project-grants.md (new; date at commit time)

#### Scope

##### In scope

- The ADR text and its decision, with no code change.

##### Out of scope

- Any grant write outside the AGENT page; the confirm and the sync job carry no grant selection.
- The client pre-fill of the permissions screen.
- The sync routes and jobs (#1972, #1976).
- Changing the risk classes or `requires_approval` defaults.

#### Acceptance criteria

- The ADR exists with valid frontmatter, a Decision stating that a confirm never writes grants and the card only pre-fills read-class tools for the user to grant on the AGENT page, its reason, the consequences and the alternatives.
- It does not contradict `docs/adr/2026-09-18-restricted-mcp-run-credentials-for-approval-gated-calls.md` or the single-writer ownership ADR, and names the header comment of `mcpProjectGrantsStore.ts` as the rule it confirms.
- A reader can tell from the ADR alone that no writer other than the AGENT page route (confirm route, agent tool, `/mcp`, queue job) may set a grant.

### Requirement gh-1416: [calendar-events 02/12] Add calendar properties to the Events schema

#### Context

Model tier rationale: One known mechanism (a schema extension plus a direct-SQL cutover for a `schema_locked` database) across defined seed, cutover and i18n seams, but it changes a persisted schema contract that many later issues build on.

The Events system database today has only `name`, `type` (select event/standup/meeting) and `date` (type `date`, config `{ includeTime: true }`) plus its relations, declared in `backend/packages/data/src/seed/seedTenDatabases.ts`. There is no end, no all-day concept and no place, link or description. `date` is a free string that nothing validates, and nobody reads `includeTime` (see the comment on `ISO_DATE_PATTERN` in `backend/packages/data/src/rollup/recompute.ts`). The Events database is `schema_locked` once seeded, so an existing tenant can only receive new properties through a code-level cutover that writes SQL directly, as `backend/packages/data/src/transcription/transcriptsCatalogCutoverMigration.ts` does for Transcripts and as `runTenantCutoverMigrations` in `backend/packages/data/src/db/tenantCutoverMigrations.ts` runs them per tenant.

This issue adds the calendar time model and the descriptive keys of an Event in a single schema change, so every later calendar area builds on one cutover instead of several. It adds no behavior: nothing normalizes, derives or validates the new values yet. Normalization and the derived `time` come from #1598, validation from #1663. Later issues add further Events keys in their own seed and cutover steps; this issue owns only the keys below.

Decision: an Event is stored as wall-clock values in the tenant time zone (a first day, an optional last day and optional start and end times), not as an instant plus a zone. An Event without `timeFrom` is an all-day Event; no `allDay` property is introduced. An end of exactly midnight is stored as `"24:00"`, and an Event across midnight uses an `endDate` on the next day.

Shared-file ordering: this issue also waits for #1410 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `db-migrations`, `canonical-keys` and `testing`.

1. In `backend/packages/data/src/seed/seedTenDatabases.ts`, extend the Events property list with these canonical keys (English camelCase), keeping `name`, `type` and `date` exactly as they are today (including `config: { includeTime: true }`, which a later issue removes):
   - `endDate` (type `date`, owner user): last day of the Event; null means the same day as `date`.
   - `timeFrom` (type `time`, owner user): start time `"HH:MM"`; null means all-day.
   - `timeTo` (type `time`, owner user): end time `"HH:MM"`, `"24:00"` allowed.
   - `time` (type `time`, owner system, `locked: true`): the derived display range, same shape as `Tasks.time`.
   - `place` (type `text`, owner user): an address or a link to a call.
   - `url` (type `url`, owner user).
   - `description` (type `longText`, owner user): Markdown, including `- [ ]` checklist lines.
   - `alertMinutes` (type `number`, owner user): minutes before the start to remind.
   - `travelMinutes` (type `number`, owner user): travel time in minutes.
   Follow the Tasks `timeFrom`, `timeTo` and `time` declarations in the same file as the pattern for the time properties.
2. Add a cutover that gives every existing tenant the same properties on its existing Events database. Create it next to the other cutovers (for example `backend/packages/data/src/calendar/eventsCalendarPropertiesCutoverMigration.ts`), copy the lock, idempotency-check and per-tenant shape of `transcriptsCatalogCutoverMigration.ts`, use direct SQL because the database is `schema_locked`, and no-op when the tenant has no Events database yet. Register it in `runTenantCutoverMigrations` in `backend/packages/data/src/db/tenantCutoverMigrations.ts`. The property definitions inserted must equal the seed's, so a fresh and a cut-over tenant have identical schemas.
3. Add the display names for all nine keys to `backend/packages/data/src/seed/i18n/cs.json` and `en.json` under the existing `property.events.<key>.name` naming (for example `property.events.endDate.name`).
4. Tests: a fresh seed creates the nine properties with the stated types and owners; the cutover on a database created by the previous seed adds exactly those properties, is idempotent on a second run, and leaves existing Events items untouched.

#### Touches

- backend/packages/data/src/seed/seedTenDatabases.ts (Events property list)
- backend/packages/data/src/db/tenantCutoverMigrations.ts (one registered cutover)
- backend/packages/data/src/calendar/eventsCalendarPropertiesCutoverMigration.ts (new)
- backend/packages/data/src/seed/i18n/cs.json (property.events.* keys)
- backend/packages/data/src/seed/i18n/en.json (property.events.* keys)
- backend/packages/data/src/__tests__ (new seed and cutover tests)
- backend/packages/data/src/calendar/__tests__/eventsCalendarPropertiesCutoverMigration.test.ts (existing seed/cutover harness for the exact Task 4 and AC, including unchanged existing items/date config and second-run idempotence)

#### Scope

##### In scope

- The nine new Events properties in the seed, the per-tenant cutover that adds them to existing tenants, and their Czech and English names.

##### Out of scope

- Normalizing times and deriving `time` on write: #1598.
- Validating dates and times, including the rules between the fields: #1663.
- Converting stored `date` values that carry a time into the new fields: #1797; removing `includeTime` from `date`: #1971.
- Validating `alertMinutes` and `travelMinutes` values and computing reminders: #1714 and #1719.
- Other Events keys (calendar, recurrence, iCalendar identity, area, files, hosted tasks), which their own issues add.
- Any Task schema change: #1540.

#### Acceptance criteria

- When a new tenant is seeded, its Events database has `endDate`, `timeFrom`, `timeTo`, `time`, `place`, `url`, `description`, `alertMinutes` and `travelMinutes` with the types and owners listed, and `time` is locked.
- When the cutover runs for an existing tenant, its Events database gains the same properties with identical definitions, its existing Events items and `date` config are unchanged, and a second run changes nothing.
- When the cutover runs for a tenant without an Events database, it does nothing and does not fail.
- The Czech and English catalogs contain a name for each of the nine keys.

### Requirement gh-1428: [journal 02/21] Refuse creating Journal entries outside the journal store

#### Context

Model tier rationale: A single create hook, but it changes what every creation path into Journal is allowed to do and a mistake would block the Inbox capture or break test fixtures.

A Journal entry exists for a period and is created implicitly on first write by `getOrCreateJournalItem` (`backend/packages/data/src/journal/journalStore.ts`), which writes `name`, `type` and `period` under the narrow `allowedSystemKeys` exception. There is no manual "New" for the Journal. Yet the generic `POST /api/databases/:journalId/items` with an empty body succeeds with 201 and creates a nameless entry without `type` and `period`: the writable-property check only inspects keys that are written (`assertWritableProperties`, `chokePoint/itemWrites.ts`), `schema_locked` blocks only schema changes, and no create hook exists for Journal. The same is true for an agent or MCP `item.create`, which is non-destructive and passes without approval. Such rows break lookups by period.

The choke point cannot import the journal module (ADR `docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md`); the create-hook registry (ADR `docs/adr/2026-10-09-item-create-domain-hooks.md`) is the way in. Hooks run after a real insert and not on an idempotency replay.

Shared-file ordering: this issue also waits for #1422 because both edit the same registry, manifest, cutover, route matrix or hook files listed in Touches.

#### Task

Load `state-writes`, `error-handling` and `testing`.

1. Add `journalItemCreateHook` in the journal module: when the created item's database is the Journal database (owner module `journal`) and the written `properties` lack a `type` or a `period`, throw `ForbiddenError` (HTTP 403) so the insert rolls back. Items created by `getOrCreateJournalItem` carry both keys and pass.
2. Register it in `backend/packages/data/src/domainWriteHooks.ts`.
3. Tests: `POST /api/databases/:journalId/items` with `{}` and with a body without properties answers 403 and creates nothing; agent and MCP `item.create` on the Journal are refused by the same `ForbiddenError` (domain status 403, code `forbidden`) through their existing native envelopes: agent `{ error: true, result: "forbidden: ..." }`, authenticated MCP HTTP 200 with JSON-RPC error -32000 and `data.code = "forbidden"`; assert no item row is created; Inbox capture (which creates a day through `getOrCreateJournalItem`) still works; a repeated `getOrCreateJournalItem` for the same period still returns the existing entry.
4. Fix any existing test fixture that created Journal rows directly without type and period by routing it through `getOrCreateJournalItem`.

#### Touches

- backend/packages/data/src/domainWriteHooks.ts (hook registration line)
- backend/packages/data/src/journal/journalWriteHook.ts (new)
- backend/packages/data/src/__tests__/ (journal hook tests; fixture fixes)
- backend/services/semprec-api/src/__tests__/itemsHandler.test.ts (Journal create case)
- backend/packages/agent-runtime/src/__tests__/genericOperationAgentTools.test.ts (only the required real agent Journal item.create refusal)
- backend/services/semprec-api/src/__tests__/mcpRunCredentialTenancy.test.ts (only the required authenticated MCP Journal item.create refusal)

#### Scope

##### In scope

- Refusing item creation in the Journal database unless it carries a type and a period.

##### Out of scope

- The lazy create route and the page; #1541.
- Restoring a trashed period; #1666.
- Titles of Journal entries; #1711.

#### Acceptance criteria

- When a client posts an item to the Journal database without `type` and `period`, then the answer is 403 and no row is created.
- When an agent or MCP tool calls `item.create` on the Journal, the underlying refusal is `ForbiddenError` with domain status 403 and code `forbidden`, and no item row is created. Preserve each transport: the agent returns an error tool result prefixed `forbidden: `; authenticated MCP returns HTTP 200 with JSON-RPC error -32000 and `data.code = "forbidden"`. REST retains actual HTTP 403.
- When an Inbox item is captured, then the day entry is still created and the capture succeeds.

## Touches

- Exactly the union of the ten current member Touches sections embedded above, in declared order. Every path retains its member's purpose and restrictions; a directory does not authorize unrelated work.
- No additional path is authorized by this aggregate. A scope correction must first update its source, exact embedded snapshot and approvals.

## Scope

### In scope

- Exactly the combined backend Tasks and AC in the requirement snapshots above, including their named tests, migrations and production composition roots.
- Coordinating shared files and migration ordinals across members, without duplicate registration or duplicate ownership.
- Independent review of the entire batch and an explicit verdict for every source criterion.

### Out of scope

- Web/mobile source, screens, navigation, client localization and client validation.
- Requirements not included in this batch, except prerequisites already delivered by earlier batches.
- Automatic approval, automatic deployment, production security sign-off by implementers, and closing a source issue merely because its code was written.

## Acceptance criteria

- Every criterion under every embedded source Acceptance criteria section passes with recorded evidence; none may be sampled, silently omitted or treated as implemented by a stub.
- Required backend tests and functional scenarios exercise production paths, including relevant failures, tenant isolation, concurrency, idempotency and populated-tenant migrations.
- Independent review has no unresolved medium-or-higher findings. Confirmed findings are fixed and affected evidence is rerun against the final candidate SHA.
- The full backend `pnpm run verify` passes. No web or mobile verification is required. A missing external service or required live-provider check is BLOCKED/NOT RUN, never PASS.
- Only after this entire gate passes may this batch and its approved source records be completed with individual handovers pointing to the verified implementation. All source approvals must still match their specifications.
- The next sequential batch starts only after this batch's gate passes; a failure holds advancement.
