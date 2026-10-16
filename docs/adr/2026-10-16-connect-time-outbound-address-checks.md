---
status: accepted
date: 2026-10-16
area: [backend]
supersedes: []
superseded-by: null
---

# Requests to user-supplied URLs resolve once at connect time and connect only to a vetted address

## Context

Two features send server-side requests to URLs a user chose: remote MCP servers (`sse` and `http`
transports) and web push endpoints. [[2026-09-27-ssrf-protection-for-stored-outbound-urls]]
validates such a URL's syntax when it is stored: `https:`, no userinfo, no port, and a DNS host that
is neither `localhost` nor an IP literal. It leaves DNS rebinding out of scope — a public name that
resolves to an internal address passes that check — and names send-time resolution as a separate
decision.

With many tenants on one host that gap is a cross-tenant path. One user's stored URL can reach the
loopback services of the host (Postgres, the AI gateway, other processes), link-local metadata
addresses or the private network. Host egress filtering (issue #1063) closes it at the network
layer, but it is invisible to the code and can be lost in a deployment change.

Resolving the name, checking the result and then letting the HTTP client connect by name would
resolve twice. The second answer can differ from the first, so the check has to sit inside the
connection itself.

## Decision

Every request to a user-supplied URL goes through the clients `createOutboundHttp()` builds in
`backend/packages/data/src/net/outboundAddressPolicy.ts`: a `fetch` for the MCP SDK transports and an
`https.Agent` for web-push. That module adds this check on top of the stored-URL baseline. It does
not replace it.

- **One resolution, pinned.** The socket's `lookup` resolves the name once with `dns.lookup(…, { all:
true })`. It refuses the connection with `OutboundAddressNotAllowedError` unless every returned
  address is allowed, and otherwise hands the socket exactly the vetted address (or the vetted list,
  when the socket asks for all of them). The socket never resolves the name again.
- **Denied ranges.** IPv4 `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`,
  `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`,
  `240/4`. IPv6 `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`,
  `100::/64`. An IPv4-mapped (`::ffff:0:0/96`) or NAT64 (`64:ff9b::/96`) address is judged by the
  IPv4 address it embeds. The table is a `node:net` `BlockList`, so addresses are compared
  numerically and never as strings.
- **Literals and protocol.** `lookup` never runs for an IP-literal host, so both clients refuse a
  literal host themselves. The `fetch` also refuses any protocol other than `https:`.
- **Redirects refused.** The `fetch` sends every request with `redirect: "error"`, so a redirect
  cannot move a request to a name or address that was never checked. web-push issues one request and
  follows no redirects.
- **Failure mapping.** For MCP, `connectMcpServer` re-checks the stored-URL baseline before it
  decrypts the credential. This covers rows written before that check existed. A baseline failure,
  or a policy refusal raised by any request the transport made while connecting, becomes
  `McpConnectionError("address_not_allowed")`. For web push, a refusal is a `permanent-failure`, and
  the fan-out revokes the subscription as it does for a 404/410.
- **Test-only loopback policy.** Contract tests run real MCP servers on `http://127.0.0.1`.
  `allowLoopbackOutboundForTests()` switches the module's default policy to one that also allows
  loopback addresses (`127/8`, `::1` and their mapped forms) and `http:`. Under it, `connectMcpServer`
  skips the baseline re-check. The switch is process-wide, because those servers are reached through
  call paths that take no policy argument. It throws unless `NODE_ENV` is `test`, and it is exported
  only through `testSupport/mcpContractServers.ts`, never from the package index.
- **Second layer.** Host egress filtering (issue #1063) stays the second layer and is still
  required. This check runs only for the clients built here.

## Consequences

- A new feature that requests a user-supplied URL builds its client with `createOutboundHttp()`.
  Using Node's global `fetch` or a default agent for such a URL is a review finding.
- The `fetch` is `undici`'s, so `@semprec/data` depends on `undici` directly. The MCP SDK sends only
  string or `URLSearchParams` bodies; the `fetch` copies the method, headers, body and abort signal
  into `undici`'s own request type, and refuses any other body type rather than casting between the
  two packages' declarations of the same web types.
- The `sse` transport's `EventSource` reduces a failed request to a message string before the SDK
  rejects `connect()`, so the MCP factory notes a refusal at its `fetch` wrapper and does not rely
  on the connect error's `cause` chain.
- Fixed provider endpoints (Gmail, Graph, IMAP, the AI gateway, APNs) take no user-supplied URL and
  are not routed through this policy. The `stdio` transport opens no network connection and is
  governed by [[2026-10-16-stdio-mcp-confined-to-admin-tenants]].
- Each MCP connection and each web push send builds its own connection pools and destroys them when
  it closes, so a refused or finished request leaves no pooled socket behind. Connections are not
  reused across sends.
