---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# IMAP STARTTLS cleanup proves the underlying transport closed

## Context

[[2026-11-02-mail-verification-cancels-imap-through-owned-sockets]] captures the
initial socket and later TLS replacement without intercepting construction.
ImapFlow 1.7.6 creates STARTTLS with tls.connect({socket: socketPlain}). A fast
certificate refusal may close that replacement before the helper can subscribe
to its close event. Missing that historical event is not itself a resource leak.

Node's public Socket.closed is useful terminal stream state but does not alone
establish native transport closure: the installed Node sets stream closed state
after its destroy callback while a native close callback may still be pending.
Polling cannot fix the subscription race, and observing every constructor would
expand the approved integration surface.

## Decision

Permit this additional verification-only teardown proof for the installed
ImapFlow STARTTLS path: the helper has retained the actual initial TCP socket
and observed its real close event; it has settled the real connect outcome and
final client cleanup; and the checked replacement TLSSocket reports closed.
The TLS wrapper must belong to this same attempt and the existing transport
path, which wraps the original socket and makes no second connection. Verify
that compatibility assumption against the library and through real STARTTLS
tests. Do not infer it for arbitrary sockets or future reconnect paths.

For a replacement found already closed, record that terminal state without
claiming to have observed its earlier close event. If the replacement is not
closed, attach its own terminal observer before cleanup and await it as before.
The initial transport's close observer remains mandatory in either branch.
Socket.destroyed, Socket.closed alone, an ImapFlow close event, a tick delay or
the absence of active handles is not a substitute. No polling, global TLS hook,
property mutation, additional private access or relaxed certificate validation.

Retain the actual certificate/connect failure and every observed secondary
error under the existing safe error rules. This proof does not reconstruct
unobserved historical TLS events or establish their cause. An uncertain socket
identity, unclosed original transport, unsettled connect or incomplete cleanup
must not be reported as successful teardown. Default adapters are unchanged.

## Consequences

The invariant is settled operation plus terminated owned network transport and
TLS wrapper, rather than a claim that every past replacement event was caught.
This narrowly supplements the earlier observation rule; its body stays intact.
Existing stalled-handshake and cancellation tests remain, and the fast invalid
STARTTLS certificate case must now prove the original transport close, checked
replacement terminal state, refusal before LOGIN and safe TLS error. Controls
must reject incomplete transport/wrapper teardown. No final gate has yet proved
this implementation and no live provider behavior is inferred.
