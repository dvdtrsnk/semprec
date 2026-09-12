---
name: io-hardening
description: What every edge of the Semprec backend must do before it is safe — inbound HTTP routes and handlers (auth, validation, body size, rate limiting, secrets) and outbound calls to any external service (timeout, response size cap, resource cleanup). Use this whenever adding or changing a route handler, a webhook receiver, or any code that calls out to IMAP, APNs, an MCP server, a provider, or any other network endpoint.
---

# Both edges: what comes in, and what goes out

The two directions fail differently, so both lists are here — most changes that
add one soon add the other.

## Inbound: a new route, handler or webhook receiver

- **Authentication and authorization, on every route.** Not just "is there a
  session" — check that the caller owns the resource being mutated. An
  identifier taken from the request body (a user id, a decided-by, an owner) is
  a claim by the caller, not a fact: verify it against the authenticated
  identity rather than trusting it.
- **Parse the body before using it.** A JSON body may be malformed, may be the
  literal `null`, may be an array where an object is expected. `JSON.parse`
  without a `try` turns a client mistake into a 500; an unchecked cast to
  `Record<string, unknown>` turns `null` into a crash at the first property
  read. Validate at the edge, then trust the type inside.
- **Cap the body.** Buffering a request body with no size limit is a way to be
  taken offline by one request.
- **Rate-limit what is reachable without a session.** Password reset, setup,
  and anything that sends mail or costs money are the obvious cases.
- **Compare secrets in constant time.** `===` on a token leaks its prefix to a
  patient attacker; use a timing-safe comparison.
- **Never put a secret in a URL.** Query parameters end up in logs, proxies and
  referrers — a token belongs in an `Authorization` header. On the web side, a
  secret in a `VITE_*` variable is baked into the bundle and is public.

## Outbound: any call to something you do not control

- **Always a timeout.** A remote endpoint that accepts the connection and then
  says nothing will otherwise hold the owning process forever. This includes
  the handshake, not just the request: an MCP server that connects and never
  finishes `initialize` hangs exactly the same way.
- **Always a cap on the response.** `res.json()` and accumulating `data` chunks
  both read an unbounded body into memory. Cap it, and make sure any fallback
  path (the one taken when the stream is missing) is capped too — an escape
  hatch that skips the limit is the same bug with extra steps.
- **Clean up what you opened, on every path out.** When a timeout wins the
  race, the underlying request keeps running unless you abort it; when a
  socket errors, the session stays open unless you close it. Both leak a
  handle per failure, which is a slow outage rather than a visible one. The
  same rule applies to any acquire-then-use pair, not just HTTP: `pool.connect()`
  hands you a client before you've done anything with it, and if the query
  that follows throws, that connection is never released — wrap the use in a
  `try`/`catch` (`listenClient.release(true)` in the `catch`, before rethrowing)
  so a failure still gives the connection back.
- **A shutdown that waits on a handshake can wait forever.** `ws.close()` starts
  a close handshake that needs the client to acknowledge it; one unresponsive
  client (dropped network, crashed tab) means the promise waiting on it never
  resolves. When you are the one tearing the server down, use `terminate()` —
  which drops the socket with no round-trip — and reserve `close()` for a
  single connection's own graceful exit.
- **Work already in flight when shutdown starts can still land after it.** An
  async step that began before the shutdown loop ran — an in-flight
  authentication that attaches its connection once it resolves, a callback
  that finishes late — is not covered by that loop just because it started
  earlier. Set a `closed` flag before the shutdown loop runs, and check it when
  the in-flight work resolves, so a late completion is rejected instead of
  attaching after the server already considers itself closed.
- **Handle the refusal you asked for.** The AI gateway refuses calls over
  budget; a provider returns 429. Surface it — do not retry-loop against a
  closed door.
- **Validate what comes back.** A response body is external input exactly like
  a request body is. See `state-writes` for the persistence side of the same
  rule.

## Escape hatch

An issue whose Task explicitly specifies different behaviour wins over this
list — say so in the code comment and in the pull request description, so the
reviewer sees the decision rather than the omission.
