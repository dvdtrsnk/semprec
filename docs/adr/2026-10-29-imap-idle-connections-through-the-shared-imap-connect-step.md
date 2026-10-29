---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# IMAP IDLE connections open through the shared IMAP connect step of the mail connection factory

## Context

[[2026-10-29-mail-connections-through-the-outbound-address-policy]] decides that a connection to a
tenant-chosen IMAP host is opened only through `openImapConnection()` in
`backend/packages/data/src/mail/mailServerConnections.ts`. That function builds the `imapflow` client
with the policy lookup and the host as TLS server name, connects, closes the client on a failed
connect, maps a refused address and every connect or TLS failure to `MailServerUnreachableError`, and
returns the connected client wrapped in `ImapFlowMailClient` (`mail/imapFlowClient.ts`), the client of
the reconcile pass. The wrapper keeps the `ImapFlow` private, and the function takes no option beyond
the policy.

IMAP IDLE (issue #196; `mail/imapIdleLifecycle.ts`, `mail/imapIdleClient.ts`) is a second IMAP client
of the same hosts, hosted by the api process from issue #1550. `createImapFlowIdleTransport` holds one
long-lived connection per folder and needs what the wrapper does not expose: `list()` and
`mailboxOpen()`, the `exists`, `expunge` and `flags` events, `logout()` and `close()`, and imapflow's
`maxIdleTime` and `socketTimeout`, which imapflow reads from its constructor options. Its
`CreateIdleTunedImapFlowClient` type returned an unconnected client that the transport connected
itself. So the IDLE transport could not be built on `openImapConnection()` as the earlier ADR's letter
requires, and the remaining way, a third `new ImapFlow(...)` in the composition root, would open a
tenant-host connection outside the factory, without its mapping and its logging rules.

## Decision

`mailServerConnections.ts` exports the connect step of `openImapConnection()` as its own function,
and IMAP IDLE connections are opened through it.

- **`openImapFlow(settings, credential, options): Promise<ImapFlow>`** is everything
  `openImapConnection()` did before wrapping: the IP-literal refusal, the client built with the policy
  lookup, the host as server name, the connect and greeting timeouts, the disabled imapflow logger and
  the error listener; the connect; the close after a failed connect; the mapping of a refusal and of
  every connect or TLS failure to `MailServerUnreachableError`, with the host name and the error's
  name and code logged and the resolved address never logged or returned. It resolves with the
  **connected** `ImapFlow` and never returns an unconnected one. `openImapConnection()` calls it and
  wraps the result in `ImapFlowMailClient`; it has no connect path of its own.
- **IDLE options are options of the connect step.** `MailServerConnectionOptions` gains optional
  `maxIdleTime` and `socketTimeout`, forwarded to the `ImapFlow` constructor, because imapflow reads
  both at construction and a caller cannot set them on a client it receives. Callers that do not pass
  them get imapflow's defaults, as before.
- **The IDLE transport never connects.** `CreateIdleTunedImapFlowClient` (`mail/imapIdleClient.ts`)
  returns a connected client, and `createImapFlowIdleTransport` calls neither `connect()` on it nor
  anything else that opens a socket. The composition root's `createClient` reads the mailbox's stored
  settings and returns `openImapFlow(...)` with the IDLE options it was given.
- **Reading of the earlier rule.** The two-factory rule of
  [[2026-10-29-mail-connections-through-the-outbound-address-policy]] is read as: every IMAP
  connection to a tenant-chosen host goes through the one connect step `openImapFlow()`, of which
  `openImapConnection()` is the sync-wrapper form. That ADR's body stays as written.

### Rejected alternative: a third `new ImapFlow(...)` in the api composition root

It would duplicate the connect configuration, skip the `MailServerUnreachableError` mapping and the
logging rules, and need `createPolicyLookup`, which the data package deliberately does not export.

### Rejected alternative: expose the raw client from `ImapFlowMailClient`

The wrapper exists so the reconcile pass sees a narrow, peek-only surface; a raw-client accessor
would hand every holder of a sync client the whole library.

### Rejected alternative: run IDLE over the sync wrapper

It would put IDLE event plumbing (`exists`, `expunge`, `flags`, the end-of-connection promise) on a
class whose contract is one reconcile pass, and rewrite the tested IDLE transport for no gain.

## Consequences

- `openImapFlow()` is the only exported function of the data package that returns a raw `ImapFlow`,
  and it returns only a connected one. A caller that needs an unconnected client has no supported way
  to get one, on purpose.
- The IDLE transport's errors after the connect arrive raw from imapflow through the connection's
  `waitForEnd()`; a socket error carries the resolved address. An IDLE `onError` logs the error's name
  and code, not the error object, so the address rule of the earlier ADR holds on that path too.
- `mailServerConnections.test.ts` keeps covering the shared step through `openImapConnection()` and
  adds the `openImapFlow()` cases: a connected client for the fake server, a refused host mapped
  without a connection, and the two IDLE options forwarded. `imapIdleClient.unit.test.ts`'s fake client
  is handed over connected and the transport is asserted never to connect it.
- The credential check before a mailbox is saved (#1569), SMTP send (#1634) and the sync adapter
  (#1510) are unaffected: they keep using `openImapConnection()` and `createSmtpTransporter()`.
