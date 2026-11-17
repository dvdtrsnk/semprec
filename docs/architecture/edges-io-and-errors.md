# Edges, I/O and errors

What every process boundary of the backend does: the HTTP API, the realtime socket, outbound
requests, logging, failure paths and shutdown. Tenant rules at the edge (trusted tenant sources,
same-origin check, auth throttles, admin gate) are in [tenancy-and-security.md](tenancy-and-security.md).
Transactions and side effects are in [transactions-and-side-effects.md](transactions-and-side-effects.md).

## Validate at the boundary, trust inside

- Validate external input where it enters: request bodies, query strings, path segments and headers;
  socket frames; webhook payloads; job payloads; NOTIFY payloads; provider and model responses;
  stored rows that a user could have written in an older shape.
- Validate against the domain of the column that stores the value, not just its JavaScript type.
  For example, an integer must fit `int4` and respect the sign the column implies. A bad value is a
  `400` naming the field, never a `500` from Postgres.
- Parse before use. `JSON.parse` sits in a `try`; a body may be `null`, an array or malformed. Every
  array gets a maximum length, every recursive walk over client-supplied JSON or schema gets a depth
  limit, and validation is explicit at the read site (`Buffer.from(s, "base64")` does not reject bad
  input).
- No `any` crosses a module boundary. After the edge has parsed a value into a typed one, inner code
  trusts the type. It does not re-check states the types exclude and has no defensive "cannot
  happen" branches. A check that guards a write against persisted state belongs in the write's own
  transaction (see [Application port](#application-port)), not in a second validation layer.
- Shared validators live in `backend/services/semprec-api/src/adapter/requestValidation.ts`
  (`assertUuid`, `requireJsonObjectBody`, …) and in the catalog's Zod schemas
  (`GENERIC_OPERATION_BINDINGS`, `parseOperationInput`).

## HTTP API

### REST contract

- Routes carry no version segment. Every change to the item envelope, the error contract or a
  route's request or response shape is additive:
  - fields may be added, but existing fields are never removed or repurposed;
  - error codes may be added to the closed enum (`ITEM_ERROR_CODES` in `adapter/errorContract.ts`),
    but an existing code's meaning and status never change;
  - a breaking change needs a new route or field name.
- Every JSON response carries `Cache-Control: no-store` (`sendJson` in `adapter/http.ts`), written
  last so that a caller cannot weaken it.

### Request handling

Every route is mounted through `createAdapterRequestListener` (`adapter/adapterRoute.ts`), which
provides these, so no route reimplements them:

- authentication by the session cookie or `Authorization: Bearer`, before the handler runs, and the
  admin gate for `admin: true` routes;
- a body cap on every read (`readRawBody`/`readJsonBody` with an explicit `maxBytes` per caller, `PayloadTooLargeError`
  mapped to 413). There is no default cap;
- errors: a `ChokePointError` becomes `{ error: { code, details } }` at its status through
  `toErrorResponseBody`. `details` pass through `publicErrorDetails`, which drops anything that is not
  a flat record of primitives. A `pg.DatabaseError` (narrowed with `instanceof`) with a classified
  SQLSTATE is answered by `databaseErrorResponse` (`adapter/errorContract.ts`) with only its code:
  `23505` → 409 `unique_violation`, `23503` → 409 `foreign_key_violation`, `23514` → 400
  `check_violation`, and `40001`/`40P01` that outlived the transaction retry → 503
  `transaction_conflict` with `Retry-After: 1`. Any other error is logged and answered `500 internal_error`;
- authorization covers ownership of the resource being mutated, not just the existence of a session.
  An identifier in the body (a user id, a "decided by") is a claim to check against the
  authenticated identity;
- a foreign resource id gets the same status, body and headers as a random id. Resolve the
  resource inside the tenant before any conditional branch (ETag/304, cache headers, early return).

The MCP endpoint (`/mcp`, `src/mcp/mcpHandler.ts`) authenticates by bearer token and dispatches the
same generic catalog.

### Custom routes

- A module manifest may declare `customRoutes`. Each entry has a method, a path under `/api`, a
  `handlerExport` and one of exactly two justifications: `transactional-semantics` or
  `single-consumer-read`. CRUD over module data belongs on the generic endpoints instead. A custom
  route still writes item and database state only through the choke point.
- `ModuleRegistry` refuses, at startup, two modules that claim the same method and path text.
  `semprec-api` mounts the active set (`getCustomRouteDefinitions()`) through the shared adapter.
- Matching follows declaration order: modules in load order, then each module's routes in manifest
  order, and the first match wins (`mountRoutes`, `adapter/routeTable.ts`). Routes are not ranked by
  specificity. When two routes of one method in one manifest overlap, the narrower is declared
  first (for example `mailThreadFacets` before `mailThreadDetail`). Overlap between two modules needs
  its own decision.
- A factory has the shape `(pool, dependencies) => AdapterHandler`. `CustomRouteDependencies`
  (`adapter/customRouteMount.ts`) is built by the composition root (`src/serve.ts`), and every member
  is optional. A handler reads a member with `requireCustomRouteDependency`, inside the request,
  never while the factory runs. A missing member fails that one request with
  `CustomRouteConfigurationError`, which becomes a generic 500, not a domain error.
- A handler in `packages/data` types its request from `data/customRoute.ts`, which mirrors the
  adapter's request structurally so the package imports no HTTP types: its context is the
  intersection of the parts it reads (`RouteParams & RouteBody & RouteUser`, ...), and it answers
  `CustomRouteResult`. The module also holds the parsers handlers share (`requireUuidParam`,
  `requestUrl`, `requireBodyObject`).

### Application port

- `backend/packages/application/src/genericApplicationService.ts` is the only implementation of
  `GenericApplicationPort`. It imports only the data package's public choke-point facade and shared
  types, never a store, SQL or a service. Each composition root builds one instance per `Pool` and
  dispatches every catalog operation through it.
- Transport adapters (REST, MCP, agent tools) only build the canonical command from their own input
  shape, validate it with the binding's Zod schema and dispatch (`dispatchGenericOperation`). They
  never reimplement a business rule, and they never build their own `createChokePoint` for an
  operation the catalog covers.
- Anything that must be atomic with the write (idempotency, events, ownership, locked or archived
  checks, ordered invariants) is checked inside the choke-point transaction. Do not split it into a
  pre-check call followed by a write call.
- A port method outside the catalog exists only to return results from a single choke-point
  transaction. It is REST-only, validated with the matching catalog operation's schema, built from
  existing choke-point calls and named `<operation>With<Extra>` (`patchPropertyWithDatabase`). If a
  second transport needs the same shape, it becomes a catalog operation.
- `packages/shared` never imports `packages/data` (dependency-cruiser rule `no-shared-data-import`).
  `shared/src/genericOperations/rows.ts` mirrors the data row types by hand and is updated in the
  same change as `packages/data/src/types.ts`.

### Bounded reads and pagination

- Every list read has a cap, and every walk over stored structure has a bound and remembers what it
  has visited:
  - `getItemPath` (`chokePoint/itemReads.ts`) stops after 1000 elements or at a repeated id, and never
    fails on a stored cycle;
  - creating a subpage refuses a parent chain with a cycle or with more than 1000 pages
    (`ValidationError` on `parent`).
- Keyset pagination keeps timestamp ties. `GET /api/notifications/resolved` takes `since` and
  optional `afterId`, orders by `(resolved_at, id)`, caps a page at 500 rows and returns
  `nextCursor`. The timestamps are formatted in SQL with six fractional digits and never pass
  through a JS `Date`.
- `page.changes` (`docs/pageChanges.ts`) replays history in one `repeatable_read` snapshot, in
  `update_id` order. It replays at most 5000 updates and 16 MiB, reads sizes before bytes, and stops
  once `limit` is filled. Exceeding the budget is a `ValidationError` on `since` with reason
  `history_window_too_large`.
- Page HTTP bindings: `POST /api/items/:id/page/insert` (`page.insert`, `core.page.write`),
  `GET /api/items/:id/page/changes` and `GET /api/items/:id/page.md` (the HTTP binding of `page.get`
  with `format: "markdown"`). `page.createSubpage` is on `core.item.write`.

## Realtime

### Channels and tenant envelope

- `semprec_events` and `semprec_agent_stream` (`backend/packages/realtime/src/pgNotifyPublisher.ts`)
  carry `{ "tenantId": <uuid>, "message": … }`. Postgres builds the envelope with
  `app_tenant_default()` in the publishing statement, never from the message body. `session_revoked`
  takes the tenant of the session's user instead.
- The `LISTEN` connection is opened under `runAsSystem`. Each envelope is validated and then handled
  under `runInTenant(envelope.tenantId)`. An envelope that fails validation is dropped with one
  `realtime_message_without_tenant` warning, which names the channel and type and never the content.
- Delivery goes only through `sendToTenant(tenantId, frame, userId?)` in `syncServer.ts`, to the
  sockets of that tenant, optionally narrowed to one user. There is no broadcast.
- Inbound frames resolve inside the socket's tenant. `doc:open` looks up the document under RLS,
  doc-sync subscriptions are keyed by `tenantId:docId`, and agent watchers and deltas are matched on
  tenant. `forwardNotification` re-checks the fetched row's `userId` against the payload.

### Payloads

- Frames are thin: identifiers, `op` and `updatedAt`, never a row's content. A client heals by
  refetching over REST. The server never buffers or replays a missed frame.
- There are two exceptions. The `notification` frame carries the resolved row, and doc-sync frames
  (`docSync.ts`) carry Yjs bytes. When a referenced `doc_updates` row is gone, doc sync falls back to
  a full SyncStep2 from `doc_snapshots`. Doc-sync writes are rate-limited per socket
  (`MAX_UPDATES_PER_WINDOW`), and inbound frames are capped (`MAX_INBOUND_FRAME_BYTES`).
- Document invalidations are coalesced per `tenant/docId` (`docInvalidationThrottle.ts`): one leading
  lookup, one dirty flag, and one fresh tenant-scoped read at the trailing boundary of a 1 s window.
  At most one lookup runs per key. The trailing read sends the current persisted state, even when
  its `lastEditedAt` is smaller than one already sent. `close` stops new reads and waits for the
  lookups it owns.

### Backpressure and outages

- Every outbound frame goes through `sendWithBackpressure` (`backpressure.ts`), never `ws.send`. Above
  `MAX_BUFFERED_BYTES` (4 MB) it closes the socket with 1013 and never drops a frame silently.
- While a socket is behind, item-scope invalidations are coalesced per `(databaseId, itemId)`, keeping
  the newest frame (`invalidationCoalescer.ts`). Only thin, idempotent frame types may be coalesced.
- Losing or regaining the `LISTEN` connection closes every socket with 1012. Clients treat 1012 and
  1013 as "reconnect and refetch".
- Closing a tenant's sockets for a revoked session or a deactivated tenant uses 4401.

## Outbound requests

### Stored user-supplied URLs

A URL that a user supplies and the server will request later is validated when it is accepted
(`validateWebPushEndpoint`, `backend/packages/data/src/push/webPushEndpointValidation.ts`, as the
baseline):

- `https:` only, no userinfo, and no explicit port unless the protocol needs one;
- the host is a DNS name, and `localhost`, `*.localhost` and every IP literal are refused.

A bad URL is a `ValidationError` naming the field. The stored value is never normalised. Where a
feature can avoid taking a URL at all, it does.

### Connect-time address policy

- Every request to a user-supplied host goes through `backend/packages/data/src/net/outboundAddressPolicy.ts`:
  - `createOutboundHttp()` builds a `fetch` (undici) and an `https.Agent`;
  - `createPolicyLookup()` is used by raw TCP/TLS clients, including IMAP and SMTP in
    `mail/mailServerConnections.ts`.

  Node's global `fetch` or a default agent is never used for such a host.
- The lookup resolves once (`dns.lookup(…, { all: true })`), refuses the connection with
  `OutboundAddressNotAllowedError` unless every address is allowed, and pins the socket to the vetted
  address.
- The denied ranges are a `node:net` `BlockList` (loopback, RFC 1918, CGNAT, link-local,
  documentation, multicast, reserved, ULA, and IPv4-mapped or NAT64 judged by the embedded IPv4).
  Addresses are compared numerically, never as strings.
- IP-literal hosts and non-`https:` protocols are refused by the client itself, and redirects are
  refused (`redirect: "error"`).
- MCP maps a refusal to `McpConnectionError("address_not_allowed")`. Web push treats it as a
  permanent failure and revokes the subscription.
- `allowLoopbackOutboundForTests()` throws unless `NODE_ENV=test` and is exported only from test
  support.
- Host egress filtering by service uid (`deploy/README.md`, "Egress of uid semprec") stays the second
  layer.

### Timeouts, caps and release

- Every outbound call has a timeout, including handshakes (MCP `initialize`). A wrapper combines the
  caller's `AbortSignal` with its own deadline (`AbortSignal.any`).
- Every response body has a size cap, fallback paths included. Results accumulated over many calls
  (an IMAP fetch, paginated listings) cap both count and total size.
- Release what you open on every path. Use `withClient(pool, fn)` or `withTransaction` (`db/pool.ts`)
  rather than a bare `pool.connect()`. Nothing that can throw runs between acquiring a resource and
  entering the `try` that releases it. A listener registered per connection is removed when the
  connection is replaced.
- Each MCP connection and web-push send builds its own connection pool and destroys it afterwards.
- A refusal the call asked for (an AI gateway budget refusal, a provider 429) is surfaced, not
  retried in a loop.

## Logging

- Each process creates one named root logger with `createLogger(name)` (`backend/packages/shared/src/logger.ts`).
  It writes newline-delimited JSON to stdout, and `LOG_LEVEL` (default `info`) selects the level.
  The logger belongs to the process entrypoint and is never exported for another process to use.
- Every executable entrypoint calls `installFatalHandlers(logger)` before its startup work. An
  uncaught exception or unhandled rejection writes one fatal record and exits non-zero.
- The factory redacts authorization headers and password, token and credential fields. That is a
  backstop, not permission to log secrets.
- Logs are not tenant-scoped. A log line or client-facing error carries ids, counts, error `name` and
  known `code`, and never user content (item properties, mail subjects, bodies or addresses, file
  names, prompts, model output) or a secret. Never log a caught error object raw: its message and
  properties can carry the content that failed.

## Error handling

- **Never swallow.** No empty `catch`, `.catch(() => {})` or `void promise` that can reject, including
  an injected async function you assume never rejects. When a failure genuinely does not matter,
  log it at the right level and say in one line why it is safe to go on. An empty `catch` written
  for one expected throw catches every unexpected one too, so catch the expected error by type or
  code and rethrow the rest. A memoized promise evicts itself when it rejects.
- **Never map an unknown exception to a domain error.** Catch only what you can identify (a typed
  error, a SQLSTATE, a provider code) and let everything else propagate to the adapter's
  `500 internal_error`. An infrastructure failure (a dropped connection, a timeout, a bug) never
  becomes `ValidationError`, `NotFoundError` or any other user-facing code. Lock contention such as
  `55P03` reaches the caller unchanged unless a decision maps it.
- **Cleanup failures never replace the original error.** `ROLLBACK`, closing a pool, removing a temp
  file or releasing a lock in `catch` or `finally` gets its own `try`/`catch`, which logs the cleanup
  failure and rethrows the primary error. `withTransaction` does this and destroys a connection whose
  `ROLLBACK` failed. Within one failure path the write that closes the state (mark failed, release the
  claim) comes first. Best-effort extras come after it in their own `try`.
- **Provider failures that carry secrets stay private.** Errors from OAuth, mail servers, MCP servers,
  model providers and similar sources can embed client secrets, tokens, URLs or content. Keep the
  original as the internal `cause` for diagnosis, and at every public boundary (HTTP body, socket
  frame, agent tool result, CLI output, log line) project only a fixed, safe classification such as
  a status, a short provider code or a fixed failure line. See `mail/oauthTokenExchange.ts` (status and short
  provider code only) and `agentTools/describeModuleToolFailure.ts` (class name and code only).
- **Leave state consistent and report the outcome you had.** A run marked started is reset or closed
  with an error status when its work throws. A step that did not do its work does not report
  success, and a partial success is its own outcome in the return value.
- **One step, one failure path.** Do not wrap several awaits in one `catch` when some of them commit
  something. Give each segment the handling its state needs. A refactor keeps the error types,
  statuses and bodies of the code it moves.
- An expected refusal is a `ChokePointError` subclass (`backend/packages/data/src/errors.ts`) with a
  code from the closed enum.

### Records that must survive a failure

An append-only row whose purpose is to record a failure (a failed `login_attempts` row, an attempt or
audit row that may stand alone) is written as an auto-committed statement on the `Pool`, never on the
client of an enclosing transaction that would roll it back. Such a function takes a `Pool`, not a
`Pool | PoolClient`, and says so in its docstring. Ordinary state writes never use this pattern.
Test it through the real route, not a shared test transaction.

## Shutdown

- A process stops in dependency order. In `semprec-api` (`src/shutdown.ts`) the order is:
  1. the tenant deactivation listener, bounded by `LISTENER_CLOSE_TIMEOUT_MS`;
  2. the sync server (1012 to every client, `LISTEN` released);
  3. the HTTP drain (`SHUTDOWN_DRAIN_TIMEOUT_MS`, then `closeAllConnections`);
  4. the Gmail Pub/Sub dispatcher;
  5. the mail live-sync root;
  6. the queue runtime;
  7. `pool.end()`, bounded by `POOL_END_TIMEOUT_MS`.
- A server tearing itself down uses `terminate()`, not a `close()` handshake that one unresponsive
  client can hold forever. The sync server's 1012 close is the exception, and it is safe only
  because its `WebSocketServer` is `noServer: true`.
- Set a `closed` flag before the shutdown loop and check it when in-flight work resolves, so a late
  completion (an authentication that attaches its socket) is rejected.
- A bounded wait that elapses is not evidence that the work stopped. Log it and move on, and keep
  observing the underlying promise.

## Service entrypoints and packaging

- A workspace package that a compiled entry reaches has `main: dist/index.js`, `types: src/index.ts`,
  and a root export with the ordered conditions `types: ./src/index.ts`, `browser: ./src/index.ts`,
  `default: ./dist/index.js`. Plain Node loads the build, and type checking and browser consumers
  use source. Subpaths get an entry only where they already exist (`@semprec/queue` and
  `@semprec/data` `./testSupport`).
- The three backend Vitest configs alias each such root, spelled exactly `^@semprec/<name>$`, to its
  `src/index.ts`, so the test tiers run against source.
- `backend/scripts/check-native-entrypoints.mjs`, run by `deploy/deploy.sh` after the build and
  before migrations or promotion, starts every compiled entry with only `PATH` and `HOME` set. Each
  entry must reach its own configuration refusal without a module-resolution failure.
  `nativeEntrypoints.e2e.test.ts` fails when a deployed entry is missing from the checker's table.
  A package that an entry newly reaches gets the manifest contract in the same change.
