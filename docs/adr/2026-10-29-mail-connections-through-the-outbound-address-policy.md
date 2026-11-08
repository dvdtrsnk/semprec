---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Tenant-chosen mail hosts connect through the outbound address policy

## Context

[[2026-10-16-connect-time-outbound-address-checks]] routes every HTTP(S) request to a user-supplied URL
through `createOutboundHttp()`, so the name is resolved once and the socket connects only to a vetted
address. Its Consequences list tenant-chosen IMAP and SMTP hosts as a known gap: they are raw TCP and
TLS connections, and `imapflow` and `nodemailer` resolve the name themselves. A tenant could point a
mailbox at `127.0.0.1`, a private address, or a public name that resolves to an internal address, and
use the connection test as a network scanner. Until this decision, host egress filtering
([[2026-10-03-host-egress-filtered-by-service-uid]]) was the only layer against that.

The host itself is already constrained at write time: a DNS name, never an IP literal, `localhost` or a
local suffix ([[2026-10-25-mail-server-settings-allow-the-standard-mail-ports]]). That is an input
contract. It cannot stop a name from resolving to an internal address, so the address is checked at
connect time.

## Decision

A connection to a tenant-chosen IMAP or SMTP host is opened only through the two factories in
`backend/packages/data/src/mail/mailServerConnections.ts`: `openImapConnection()` and
`createSmtpTransporter()`. Both use the policy lookup of `backend/packages/data/src/net/outboundAddressPolicy.ts`
(`createPolicyLookup`) and never let the library resolve the name.

- **IMAP.** `imapflow` passes its `tls` options to `tls.connect`, so the factory sets `tls.lookup` to the
  policy lookup and `tls.servername` to the host. The socket connects to the vetted address, and the
  certificate is checked against the host name.
- **SMTP.** nodemailer's `getSocket` hook opens the plain TCP socket with `net.connect({ host, port, lookup })`
  and hands it over connected. nodemailer then runs TLS (`security: tls`) or STARTTLS (`security: starttls`,
  `requireTLS`) on that socket with the host as the server name. On this path nodemailer's own resolver is
  not reached, so the name is resolved once, by the policy.
- **Refusal and failure.** A refused address and every connect or TLS failure reject with
  `MailServerUnreachableError` (`mail_server_unreachable`, in `providerTypes.ts`). The mapped error has no
  cause and names no address, so a refused address cannot be told apart from an unreachable server. The
  host name and the error's name and code are logged. The resolved address is neither logged nor returned.
- **Authentication stays distinct.** A rejected login rejects with the library's own error (imapflow's
  `authenticationFailed`, nodemailer's `EAUTH`) and is never mapped to `mail_server_unreachable`.
- **SMTP codes.** nodemailer's `_formatError` overwrites the code of a socket error, a TLS handshake
  failure included, with its own `ESOCKET` or `ECONNECTION`, so the TLS code of the cause is not
  available on SMTP. These two codes are therefore the mapping for the whole SMTP socket-and-TLS path.
  A refused STARTTLS arrives as `ETLS`.
- **Transport surface.** `createSmtpTransporter()` returns `verify`, `sendMail` and `close`. The first two
  apply the same mapping, so no caller sees nodemailer's error for a connect failure.
- **Test seam.** Tests reach fake local servers only through `allowLoopbackOutboundForTests()`, the same
  seam the MCP contract tests use. The seam adds no production path.

## Consequences

- The IMAP sync adapter (#1510), the credential check before a mailbox is saved (#1569) and SMTP send
  (#1634) open their connections through these two factories. A new raw-socket client to a tenant-chosen
  host adopts the policy lookup, or records in its own ADR why it cannot.
- A route that catches `MailServerUnreachableError` must not re-label it, wrap it with the cause, or put
  the host's address in its response. The status mapping of `mail_server_unreachable` is owned by the first
  route that returns it (#1569).
- The factories accept an optional `policy`, mirroring `createOutboundHttp(policy)`. Production code passes
  none and uses the module policy, which the tests switch through the seam above.
- imapflow's own logger is disabled in the factory, because its default console output carries the protocol
  traffic, server responses included. Logs carry the host name and the error name and code only.
- The SMTP mapping cannot tell a TLS failure from another socket failure, and a connection reset after the
  message was sent maps to `mail_server_unreachable` as well. Such a send is reported as unreachable, and
  the caller must not assume the message was not accepted.
- Host egress filtering remains the second layer and stays required.
- OAuth2 access tokens are not an input here: tenant-chosen hosts take the app-specific password the
  settings store keeps outside its rows. A decision that adds OAuth to tenant hosts must extend this
  decision.
