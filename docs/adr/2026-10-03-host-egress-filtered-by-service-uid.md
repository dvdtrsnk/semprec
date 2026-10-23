---
status: accepted
date: 2026-10-03
area: [cross-cutting]
supersedes: []
superseded-by: null
---

# Host egress is filtered by service uid with a deny-list

## Context

[[2026-09-27-ssrf-protection-for-stored-outbound-urls]] validates stored URLs syntactically and
leaves DNS rebinding to "egress filtering on the host that runs the sending process", noting that
`deploy/nftables.conf` filtered inbound traffic only. Tenants supply outbound targets (remote MCP
URLs, web-push endpoints, IMAP/SMTP hosts), so a public name resolving to an internal address
would still reach loopback services, the private network or cloud metadata. This ADR adds that
host layer; it does not supersede the ADR above, whose application-level check stays.

## Decision

- `deploy/nftables.conf` gains an `output` chain (`policy accept`) that jumps to a
  `semprec_egress` chain only for `meta skuid "semprec"`. Root, Caddy, Docker and apt are untouched.
- The chain is a **deny-list**, not an allow-list: IMAP, SMTP and MCP ports are chosen by tenants,
  so ports cannot be enumerated, but the dangerous destinations can. Two interval sets
  (`semprec_blocked_v4`, `semprec_blocked_v6`) hold loopback, RFC 1918, link-local/metadata, CGNAT,
  ULA, NAT64, multicast and similar ranges.
- Order: established/related accept (replies of the api and gateway listeners), DNS to any
  address, then the loopback exception, then log and reject for the blocked sets.
- The loopback exception for Postgres (`5432`) and the gateway (`3002`) matches the conntrack
  **original** destination (`ct original ip daddr` / `ct original proto-dst`), because Docker
  reaches the container through `docker-proxy` or DNAT depending on `userland-proxy`; the rule
  holds for both.
- Blocked traffic is **rejected** (`icmpx admin-prohibited`), not dropped, so a blocked connection
  fails at once instead of waiting out a client timeout. Logging is rate-limited and a separate
  rule, so a `limit` that does not match cannot skip the reject.

## Consequences

- An SMTP relay, IMAP server or MCP server on a private or loopback address is unreachable.
- `AI_GATEWAY_PORT` must stay `3002`; changing it requires changing the ruleset.
- `SEMPREC_DOMAIN` must resolve to a public address for the dead-man probe.
- A tenant cannot use DNS rebinding to reach internal addresses through the services.
- Stricter rules for a sandbox uid (denying all loopback) are a separate decision.
