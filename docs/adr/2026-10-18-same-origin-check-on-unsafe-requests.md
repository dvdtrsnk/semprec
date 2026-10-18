---
status: accepted
date: 2026-10-18
area: [backend]
supersedes: []
superseded-by: null
---

# Same-origin check on unsafe requests and the sync upgrade

## Context

Browser sessions authenticate with the cookie `Path=/; HttpOnly; Secure;
SameSite=Lax`. `SameSite=Lax` keeps that cookie off cross-site subresource
requests. It does not keep it off requests from a different origin on the
same site, such as a sibling subdomain. Before this decision, neither the HTTP
dispatcher nor the `WS /api/sync` upgrade checked `Origin`, so a page on
another origin could send state-changing requests with the user's cookie, or
open a cookie-authenticated socket (cross-site WebSocket hijacking).

No configured public origin exists to compare against. `APP_BASE_URL` defaults
to `http://localhost:3000` and is not enforced. In development the Vite dev
server proxies `/api` and `/mcp` without rewriting `Host` or `Origin`, and in
production Caddy's `reverse_proxy` passes `Host` through. In both, a
same-origin browser request arrives with the `Origin` host equal to the request
`Host`.

## Decision

A request is **same-origin** when it has no `Origin` header, or when its
`Origin` parses as an `http:` or `https:` URL whose host (hostname and port,
lowercase) equals the request's `Host` header (lowercase). Any other value is
refused, including `Origin: null`, an unparseable value, another scheme, a
missing `Host`, and a mismatch. The check never reads `X-Forwarded-Host` or any
other client-settable forwarding header.

The check runs in two places, both in `backend/services/semprec-api`:

- **Unsafe HTTP methods.** Every method other than `GET`, `HEAD` and `OPTIONS`
  that fails the check is answered `403` with `{"error":{"code":"origin_not_allowed"}}`
  before any routing. No listener runs. One `origin_not_allowed` warning is
  logged with `method` and `path` only. The check is implemented in
  `src/originCheck.ts` and applied in `dispatch` in `src/app.ts`.
- **WebSocket upgrade.** `WS /api/sync` refuses a foreign `Origin` with
  `HTTP/1.1 403 Forbidden` on the raw socket, and destroys the socket, before
  `authenticate` runs. The wrapper is applied in `src/syncHandler.ts`.

Non-browser clients send no `Origin`, so they pass unchanged. These include native
clients, MCP clients on `/mcp` with a bearer token, the Microsoft Graph webhook
(`POST /api/mail/graph/webhook`) and `curl`. Browsers always send `Origin` on a
WebSocket handshake and on every non-`GET`/`HEAD` request.

## Consequences

- A request with a foreign `Origin` that changes state fails before a handler
  sees it, so no route needs its own origin check.
- The check trusts `Host`. A deployment behind a proxy that rewrites `Host`
  will refuse its own browser requests. Both the Vite proxy and Caddy in this
  repository pass `Host` through.
- A client that is not a browser can still forge `Origin`. This is not a
  browser protection, and it does not claim to be one. Authentication still
  applies to every request.
- Browsers send `Origin` on same-origin `POST` requests, so the rule matches
  what they already send and needs no client change.

## Rejected alternatives

- **An `APP_BASE_URL` allowlist.** Development runs the web client on the Vite
  dev server behind a proxy that forwards `Host` and `Origin` unchanged, so the
  configured base URL differs from the browser's origin. The allowlist would
  refuse legitimate development traffic.
- **CSRF tokens.** They would require every client, native and web, to fetch
  and send a token. That is a client protocol change this decision does not
  need.
- **`SameSite` alone.** `SameSite=Lax` does not cover a cross-origin page on
  the same site, such as a sibling subdomain.
