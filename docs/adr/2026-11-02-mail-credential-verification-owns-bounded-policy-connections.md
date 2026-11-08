---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# Mail credential verification owns bounded policy connections

## Context

Gh-1569 requires a 15-second attempt spanning resolution, connection, TLS and
login. The existing factories have 30-second connection limits and deliberately
collapse connection and TLS failures into one safe unreachable error under
[[2026-10-29-mail-connections-through-the-outbound-address-policy]]. IMAP's
shared step returns only a connected client under
[[2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step]]. A
wrapper cannot cancel an unreturned client or reconstruct information erased by
these mappings.

Installed nodemailer 9.0.6 owns its TLS socket inside its private SMTP connection
and overwrites asynchronous socket/TLS error codes with ESOCKET or ECONNECTION.
Its public getSocket hook supplies the underlying TCP socket, not that private
connection. Guessing certificate rejection from these codes or response text is
not reliable. A replacement SMTP implementation or private/global TLS hooks
would add a larger protocol and dependency contract merely to improve an error
label. Reject those alternatives for this issue.

## Decision

Add a closed credential-verification path inside the existing
`mailServerConnections.ts` owner, sharing its policy lookup, constructors and
connection ownership. It may use verification-specific typed sanitized failure
categories and a 15-second whole-attempt deadline. It returns verification
success only after authenticated TLS and cleanup; it exposes no unconnected
library client. The verification orchestrator does not open sockets itself.
Existing sync, send and IDLE callers retain their defaults, error mappings,
timeout values and public connected-client contracts.

Preserve fixed iCloud endpoints and generic candidate order. STARTTLS requires
a plaintext greeting/upgrade exchange; it must never send LOGIN/AUTH credentials
before verified TLS. Require TLS/STARTTLS and normal certificate/hostname
validation. Policy-refused addresses are never dialed and remain indistinguishable
from ordinary unreachable servers. Do not expose resolved addresses, raw causes,
server responses, passwords or certificate details in verification errors/logs.

Return `mail_tls_failed` only when an actual unambiguous machine-readable TLS
failure or required-upgrade refusal is available before default mapping. Keep
ambiguous SMTP socket/TLS failures as `mail_server_unreachable`, including
certificate failures whose original code has been erased. ESOCKET, ECONNECTION
and a timeout alone do not prove a TLS failure. Authentication rejection retains
the generic/iCloud distinction. If every candidate of a protocol fails, use
observed authentication rejection first, otherwise definite TLS failure,
otherwise unreachable; unknown errors are not silently relabeled. This changes
the original universal TLS-diagnosis requirement, not the encrypted-login rule.

The helper owns the deadline before DNS starts, the constructed IMAP client or
SMTP transport and underlying sockets, and terminal error/close observations.
Expiry actively closes/destroys owned network resources and settles the library
operation; a Promise.race alone is insufficient. Fence late lookup/connect
callbacks so they cannot deliver a socket, authenticate or report success after
expiry. Keep terminal observers until actual owned network settlement, then
remove owned timers/listeners before the next candidate or return. Finite tests
must observe this cleanup rather than assume transporter.close cancels a private
handshake. No global library monkeypatch, private SMTP-connection access or new
SMTP parser is authorized.

Node's OS-backed dns.lookup has no public per-call cancellation contract. The
deadline therefore fences its result; it does not promise to terminate the OS
resolver request. A late callback retains only the owner needed to discard its
result and cannot initiate a connection. Controlled late-DNS tests must release
and settle their callback before restoring their own test seam. Do not claim
universal OS/driver cancellation from these finite scenarios.

## Consequences

Some real TLS failures yield a generic unreachable error, which gives less
specific advice while still refusing the insecure/invalid connection. A precise
SMTP certificate diagnosis would need a separately approved library/protocol
change. Default mail behavior and its existing privacy boundary stay intact.

Tests use owned fake IMAP/SMTP servers through the existing loopback seam. Cover
both encrypted modes, certificate refusal, missing STARTTLS, authentication,
policy denial, slow DNS/greeting/handshake/login and finite late completion with
actual socket close/settlement, no plaintext credential transmission and no
secret-bearing serialized application output. Live provider checks remain
unperformed. Verification saves no mailbox, settings or credential.
