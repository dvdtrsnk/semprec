---
status: accepted
date: 2026-09-27
area: [backend]
supersedes: []
superseded-by: null
---

# Stored user-supplied outbound URLs are validated at registration; DNS rebinding is left to egress filtering

## Context

A web-push subscription (issue #631) carries an `endpoint` URL chosen by the client. The server
stores it and later POSTs to it with a signed VAPID JWT. Anyone who can register a subscription can
therefore make the server send requests to a URL of their choosing — a server-side request forgery
(SSRF) vector into loopback services, the private network the host sits on, or cloud metadata
addresses.

Web push is the first feature that stores a user-provided URL for a later server-side fetch, but it
will not be the last: calendar hooks, notification callbacks or any webhook-style integration face
the same threat. Where a feature can avoid accepting a URL at all, it already does — the pyannote
provider uploads audio itself rather than taking a caller-supplied `audioUrl` — but web push cannot:
the push service's URL is the protocol.

The real alternatives for the features that must accept one:

- **Resolve and check at send time.** Resolve the hostname immediately before every request, reject
  private and loopback addresses, and pin the connection to the resolved address. This is the only
  in-process defence against DNS rebinding, but it needs a custom agent/lookup hook on every
  outbound client, and an address-range table that has to be kept right (IPv4-mapped IPv6, CGNAT,
  link-local, NAT64 …).
- **Validate the URL's syntax at registration.** Cheap, synchronous, testable as a pure function,
  and rejects every attack that names the target directly. It cannot see what a DNS name resolves
  to, so a public name pointing at an internal address passes.
- **Rely only on network egress filtering.** Correct against every variant, including rebinding,
  but invisible to the code and easy to lose in a deployment change.

## Decision

Every feature that stores a user-provided URL for a later server-side request validates it at the
point it is accepted, before it is stored, and rejects it with a `ValidationError` naming the field.
The baseline check — the one `validateWebPushEndpoint` in
`backend/packages/data/src/push/webPushEndpointValidation.ts` implements — is:

- the scheme is `https:`;
- no userinfo (`user:password@`);
- no explicit port unless the feature's protocol genuinely requires one;
- the host is a DNS name: `localhost`, `*.localhost` (trailing root dot included) and IP literals of
  every kind are rejected outright. Real third-party services are addressed by DNS name, so refusing
  all literals closes loopback, RFC 1918, link-local, CGNAT and IPv4-mapped IPv6 without maintaining
  a range table.

A feature may apply a stricter check (an allowlist of known provider hosts, say); a weaker one needs
its own ADR.

DNS rebinding — a public name that resolves to an internal address — is explicitly out of scope for
this application-level check. Defending against it is the deployment's job, through egress
filtering on the host that runs the sending process.

## Consequences

- The SSRF surface of each such feature is one pure function that runs in the unit tier, and a bad
  URL is refused to the client at registration time instead of failing silently at send time.
- The stored value stays exactly what the client sent; validation never normalises it, so a
  feature whose URL is also its identity (web push's `ON CONFLICT (endpoint)`) keeps a stable key.
- The rebinding gap is real until the deployment actually filters egress. Nothing in `deploy/`
  does so today — `deploy/nftables.conf` filters inbound traffic only and its `output` chain
  accepts everything — so until it does, a user who controls a DNS name can still reach an internal address
  through it. Adding that filtering, or moving to send-time resolution, is a separate decision.
- Enforcement is review: a new stored outbound URL accepted without this check (or a documented
  equivalent) is a finding. No lint rule or CI scan checks it mechanically.
