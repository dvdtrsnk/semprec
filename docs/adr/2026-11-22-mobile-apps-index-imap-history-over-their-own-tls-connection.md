---
status: accepted
date: 2026-11-22
area: [mobile]
supersedes: []
superseded-by: null
---

# Mobile apps index an IMAP mailbox's history over their own TLS connection

## Context

The server imports an IMAP mailbox's live mail and its last 90 days itself; older history is index-only and, without
a client, the server backfills it slowly from its own address, which pulls years of every account's history through
one IP that providers may block. The server accepts that history from a native client instead
(`docs/architecture/domain-mail-and-inbox.md`, "History upload from a native client"): the client leases a folder,
fetches the raw IMAP responses itself and uploads them. A phone or Mac that just connected the account has the
password the person typed in memory and reaches the provider from the person's own network.
[[2026-11-15-mobile-http-client-is-ktor-and-the-session-lives-in-the-keychain]] makes `ApiClient` the only class
that opens a connection; this adds a second one, to a server that is not Alldots's, with a credential.

## Decision

- `:shared:data` holds a minimal, read-only IMAP client (`ImapClient`): greeting, `CAPABILITY`, `AUTHENTICATE PLAIN`
  when offered (else `LOGIN`, quoted or as a literal), `EXAMINE`, `UID SEARCH UID`, `UID FETCH` of the server's
  `MAIL_HISTORY_FETCH_ITEMS` and `LOGOUT`. It frames responses with their literals and keeps each untagged FETCH
  response's bytes as the server sent them, which is what the upload carries. It is no general mail client: nothing
  else uses it, and it writes nothing on the IMAP server.
- The socket is an `expect`/`actual` byte stream: Network.framework on Apple (iOS and macOS), `javax.net.ssl` on the
  JVM and Android, in a `jvmAndAndroid` source set. Implicit TLS on port 993 only, TLS 1.2 at least, the platform's
  trust store and the certificate checked against the host name; never a plain connection and never STARTTLS. A
  server that offers IMAP only with STARTTLS on 143 is left to the server's own backfill.
- Every outbound step is bounded: 30 s for the TCP connect and the TLS handshake together, 60 s of silence while
  reading, 5 minutes per command, 1 MiB per response and 24 MiB per command. A connection the caller does not get (a
  failure, a timeout or a cancellation, also one that arrives once the handshake or the sign-in finished) is closed.
  A failure is a typed value (`ImapFailure`: auth rejected, TLS, unreachable, timeout, protocol, refused) that carries
  no server text and no credential.
- The password is never stored on the device. The use case `IndexMailHistory` (`:shared:domain`) takes it as a
  `MailHistoryLogin` (whose `toString` omits it) for one run; the accounts list's ViewModel queues the logins of the
  accounts it connected and runs them one at a time, so one IMAP connection at most per screen, in its
  `viewModelScope`. A login is dropped when its run ends or the screen's ViewModel is cleared; a closed screen ends the
  run, logs out and releases the lease.
- The logout and the release are the only work that outlives a closed screen: they run past its cancellation
  (`NonCancellable`), each bounded (5 s for the logout, 10 s for the release, which otherwise expires on its own
  within the lease), and they change nothing the closed screen shows.
- The history routes are not announced as writes of the window (`AuthenticatedApi.announces`): their leases change
  nothing a screen shows, and their slices, every few seconds, only add history older than the server's window.

## Consequences

- An account connected on the device has its old history indexed while the accounts list stays open; leaving the
  screen hands the rest back to the server, as does any failure.
- Signing an account in again does not index history; only a new connect does.
- A second client of the same kind (another provider, a background task that outlives the screen) is a new decision:
  it would have to keep the password, which this record rules out.
