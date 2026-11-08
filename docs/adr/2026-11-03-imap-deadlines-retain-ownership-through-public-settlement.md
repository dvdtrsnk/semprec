---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# IMAP elapsed deadlines request close and retain ownership until settlement

## Context

The move-step contract in
[[2026-11-03-mail-moves-use-durable-step-claims-outside-transactions]] and hosted
IDLE contract in
[[2026-11-03-hosted-imap-idle-owns-startup-retries-and-private-diagnostics]]
require bounded work without orphaned cleanup. ImapFlow's socket timeout measures
inactivity, not total command duration. Its public close normally settles pending
commands, but the library catches some internal teardown errors. Public LOGOUT
false is ambiguous: it can describe an already closed client or a caught failure.
No application can reconstruct errors the library never exposes.

## Decision

Apply elapsed deadlines to the new IMAP move preparation sequence and each claimed
move step, independent of socket activity. The production limit is 30 seconds per
preparation/step. A timer requests public client.close on the exclusively owned
connection and forbids new commands/steps on that connection. Keep the actual
operation promise and all received error/event/close outcomes owned through
settlement; a Promise.race result alone never releases the limiter, marks shutdown
complete or permits destructive continuation. A late acknowledgement after the
deadline does not authorize completion or another mutation: retain the observed
value internally and leave a claimed mutation uncertain. Preparation timeout
cannot dispatch a mutation. Do not add a private parser/socket hook, global patch,
background retry or detached executor.

The existing IDLE logout grace is ten seconds. On expiry actively request public
close and join actual logout/owned work, retaining failures in operation-first
order, including undefined/non-Error values and a synchronous close throw.
A public LOGOUT false is retained as ambiguous observation, not reconstructed
as an authentication, missing-message or known provider failure. Emit a fixed
stage/category diagnostic and attempt public close; account for both the logout
promise and available public lifecycle-close observations. Do not claim a server
LOGOUT acknowledgement from false, or OS-level socket closure from a public event.
Known already-observed terminal public close can be reused rather than awaiting
a second event that cannot occur. Do not turn the ambiguity alone into an invented
domain error. Diagnostic failure cannot skip close or settlement.

There is an explicit public-library limitation: elapsed deadlines bound the time
before a cancellation/close action, not guaranteed total teardown time under a
library failure to settle after close. If owned work remains pending, retain its
owner and required resource slot, keep stop/cleanup pending, emit only a fixed
unresolved-cleanup diagnostic and do not release the database pool as though stop
succeeded. Mark that condition as unresolved/readiness-blocking in evidence;
there is no second race that abandons it or reports successful bounded shutdown.
A process/worker-isolation solution would require separate scope and is not
introduced here. This narrows the earlier unqualified bounded-shutdown wording
only for this concrete unsupported public-library condition. Normal supported
close-driven settlement remains required and tested.

Keep actual primary/secondary identities internal until owned settlement and
cleanup, then use the already approved fixed cause-free outward/private diagnostic
boundary. Errors arriving from discovery, credential, limit or connect work after
stop began are still owned failures. A retryable error observed and handled before
stop need not retroactively fail stop; a later outstanding rejection may not be
dropped by checking a mutable stopped flag. Preserve a connection-end error when
close also fails. At the existing waitForEnd interface resolved undefined means
clean end; a rejection with undefined remains a failure by presence.

## Consequences

Finite controls cover continuously active but over-deadline move preparation and
step work, close-driven actual settlement, late acknowledgement blocked, LOGOUT
false, primary plus distinct close/diagnostic failures, and pending ownership until
a controlled late settlement. Tests release every intentionally held promise and
own their cleanup. Real local library/server controls establish only the observed
public behavior. They do not prove a total shutdown bound under arbitrary library
failure, hidden-error identity, OS socket termination or live provider delivery.
