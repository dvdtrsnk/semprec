---
status: accepted
date: 2026-10-25
area: [backend]
supersedes: []
superseded-by: null
---

# Mail server settings allow the standard mail ports and a DNS-name host

## Context

A mailbox that syncs over IMAP or sends over SMTP needs a server host, a port, a security mode and a
username, chosen by the user (issue #1473, table `mail_account_server_settings`). The server later
connects to that host, so the host is a stored user-supplied outbound target, the case
`docs/adr/2026-09-27-ssrf-protection-for-stored-outbound-urls.md` covers for URLs. That ADR rejects an
explicit port in a stored URL. A mail server cannot follow that rule: IMAP and SMTP are not served
on the default port of a URL scheme, and the port is what selects implicit TLS or STARTTLS.

## Decision

- The port is stored and must be one of 993 (IMAP over TLS), 143 (IMAP with STARTTLS), 465 (SMTP over
  TLS) or 587 (SMTP with STARTTLS). Port 25 and every other port are refused. This is a recorded
  exception to the "no explicit port" rule of the stored-URL ADR, limited to these four ports.
- The host must be a DNS name, lower-cased, at most 253 characters, with valid labels. An IP literal
  in any notation (dotted, decimal, hex, octal, IPv6, bracketed), `localhost`, and names ending in
  `.localhost`, `.local` or `.internal` are refused.
- The security mode is `tls` or `starttls`. The username is stored in the row; the password stays in
  `external_credentials`.
- The checks run in `mail/mailServerSettingsStore.ts` and the database repeats the port, security and
  all-or-none rules as CHECK constraints.

## Consequences

- A DNS name can still resolve to a private or loopback address, or change its answer between the
  check and the connection. The input rules above do not make the host safe. What makes it safe is
  the connect-time address check of issue #1478, which resolves the name and pins the connection to
  an allowed address. Code that connects to a stored host must not do so before that check exists.
- A user cannot point a mailbox at a server on a non-standard port. Widening the list needs a new ADR.
