---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# Mail verification cancels IMAP through observed owned sockets

## Context

[[2026-11-02-mail-credential-verification-owns-bounded-policy-connections]]
requires the actual connect operation and network resources to settle. In
installed ImapFlow 1.7.6, close() clears its connection timer but does not reject
connect() before initialReject is installed. Calling close() first during DNS
or the initial transport handshake can therefore leave connect() pending. Its
own close event is synchronous and precedes the underlying socket close event.

The public unbind() method is not an observation hook: it detaches the connection
error handler needed to reject a pending connect. A shorter built-in connection
timer alone does not establish whole-attempt cancellation or actual socket
closure. Patching the dependency or writing its private rejection/timer fields
would spread the compatibility surface further.

## Decision

Allow one private compatibility accessor inside mailServerConnections.ts for
verification only. It reads ImapFlow's own socket data property as unknown and
accepts it only after a runtime node:net.Socket check (including TLSSocket).
Document the installed 1.7.6 behavior/version at this accessor and cover it with
real-library regression tests. Do not expose the socket, add an unchecked type
cast, modify private fields/callbacks, detach library handlers through unbind,
patch dependencies or globally intercept constructors. A library upgrade must
re-establish the tested contract; an unexpected shape is not proof of cleanup.

Capture the actual initial socket immediately after starting and observing
connect(), and capture any replacement TLS socket before cancellation or final
cleanup. Retain owned error/close observers on each distinct socket. Verification
disables compression so it does not acquire unrelated compression streams.
Keep normal sync/send/IDLE construction and ownership unchanged.

At expiry mark the attempt expired before taking cancellation action. Destroy
the current owned socket with a fixed, secret-free owner cancellation error
while the library's handlers remain attached; let the actual connect promise
reject through those handlers before final public close(). Do not call public
close() first in the pre-connect phase. Use normal connect mode rather than
verifyOnly, whose close/rejection behavior differs. An earlier bounded library
timer may be additional protection, not the sole settlement argument.

Observe the real connect outcome and terminal Socket close events; destroyed
alone and the synchronous ImapFlow close event are insufficient. Preserve an
unexpected primary/secondary outcome rather than treating every post-expiry
error as expected cancellation. Late DNS and connect results remain fenced
under the preceding decision. Do not report success or begin the next candidate
while owned network work remains outstanding. This does not promise that an
arbitrary dependency regression or OS resolver operation can be cancelled.

## Consequences

This is explicit narrow compatibility debt for a single read-only library
property, not a general permission to use library internals. It avoids a new
IMAP implementation and keeps connection creation in its existing policy owner.
No SMTP private connection access is authorized.

The parent ran a bounded library-only held-DNS diagnostic: destroying the
captured socket rejected connect() with the exact cancellation object, the real
Socket close event occurred, and a delayed DNS failure callback settled without
returning a network address. This establishes that finite library path only.
Production-helper tests still must cover delayed DNS, initial TLS handshake,
greeting, STARTTLS replacement, authentication and success cleanup, preserving
deadline, TLS validation, privacy and error ownership. Their results and the
final review/gates remain separate evidence.
