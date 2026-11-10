---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Own hosted IMAP IDLE discovery retries and private diagnostics

## Context

Gh-1550 hosts IDLE in the API. Initial folder discovery currently runs outside
backoff, and connection-limit lookup can reject outside its owned loop catch.
The API logger also records tenant-controlled folder paths and arbitrary error
name/code. [[2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step]]
allowed name/code logging, which is insufficient for secret-bearing arbitrary
library failures. This standalone exception leaves its connection policy intact.

## Decision

The hosted lifecycle owns one discovery/startup task and its folder loops,
including credential/settings/folder discovery and per-round limit lookup.
Policy refusal and transient lookup/connection errors enter the existing bounded
backoff instead of escaping an unobserved background promise. Preserve genuine
typed refusal semantics internally; retries do not imply a connection succeeded.
Start must not block the process forever on a refused account. Stop cancels its
owned waits and joins discovery, signals, active connection cleanup and loops
before the root/pool shutdown completes. Repeated start/stop must not duplicate
owners, leave timers/callbacks after stop or spawn work after pool release.
Preserve the shared connection limiter, address checks and connected-client
handoff; no third raw transport or host-policy bypass is authorized.

Retain original and secondary values internally through actual settlement and
cleanup, including undefined and diagnostic failures. At the API diagnostic
boundary emit only fixed stage/category and necessary trusted mailbox id; omit
folder path, arbitrary error name/code/message/stack/cause/aggregate members,
credentials, addresses and transcripts. Unknown outward lifecycle failures are
fixed cause-free generic errors, not fabricated auth/unreachable diagnoses.
A failed logger cannot skip later cleanup, leak raw values or become an unhandled
rejection. Do not sanitize unrelated SQL globally or weaken known domain guards.

## Consequences

The existing lifecycle-owner and API composition test paths gain finite startup
refusal/retry, limit rejection, stop-during-discovery/backoff, signal/cleanup and
secret-bearing error controls. Full root shutdown still closes IDLE before its
pool. These local fakes do not establish live IDLE delivery. The historical ADR
body and its connect-policy contract remain unchanged; no generic supervisor,
new scheduler, hosted Gmail/Graph lifecycle or manual credential flow follows.
