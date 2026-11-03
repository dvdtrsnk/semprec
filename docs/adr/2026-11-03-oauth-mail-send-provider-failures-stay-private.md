---
status: accepted
date: 2026-11-03
area: [backend]
supersedes: []
superseded-by: null
---

# Gmail and Graph send provider failures stay private

## Context

Gmail sending must never expose message bytes or tokens in errors. Graph
sending additionally uses provider-issued preauthenticated upload URLs. An
arbitrary fetch, response-reader, MIME-library or cleanup rejection can carry
these values in its text, name, properties, nested cause or non-Error value.
Preserving such an exception across a public send boundary would disclose
secrets; guessing a domain diagnosis would misrepresent the failure.

[[2026-11-02-bearer-sync-failures-stay-private]] covers sync reads and explicitly
excludes send/upload endpoints.
[[2026-11-02-smtp-and-imap-sync-isolate-secret-bearing-provider-failures]] covers
other finite boundaries. This decision extends their internal/outward
distinction to the send surfaces below, without changing their accepted bodies
or applying a global mail error policy.

## Decision

### Private operation boundaries

After token acquisition, isolate the actual send fetch and response operations
in GmailRestClient.sendMessage and GraphRestClient's sendMime, createDraft,
createUploadSession, uploadChunk, sendDraft and failed-send deleteMessage path.
Include their bounded success/error body consumption, JSON/shape processing,
reader cancellation/release and upload response cleanup. The private Graph
writeRequest helper currently serves these send methods; unrelated sync reads,
flag modifications and folder operations keep their existing contracts. Also
isolate the MIME-library parsing call used to construct a Graph draft, since
its unknown failures may contain the input message. Do not wrap SQL, credential
lookup/persistence, choke-point writes or unrelated application parsing in a
blanket provider catch.

Keep getAccessToken outside these provider catches. Its tenant scope, refresh
commit ordering, credential lock, typed errors and privacy contract remain
governed by
[[2026-11-02-mail-oauth-rotation-holds-the-credential-lock-through-refresh]].
Do not move a send/upload into that database transaction or weaken the
non-transactional HTTP rule.

Within each operation owner retain actual primary and secondary values, their
presence and observation order, including undefined/non-Error, through its
owned settlement, cleanup and diagnostic processing. At that client's privacy
boundary an unknown provider/library failure becomes a fresh fixed generic
Error without raw cause, properties or aggregate members. The enclosing draft
owner retains that safe primary's identity through its own delete/diagnostic
cleanup. This deliberately does not promise raw identity across the privacy
boundary or require a private carrier to retain raw values after ownership
ends. No public raw-error callback, durable raw store or filtering framework.

An unknown failure remains an ordinary failure: do not infer authentication,
recipient refusal or unreachability from arbitrary thrown objects, names or
text. Preserve the established genuine HTTP/status and recipient-classification
branches, but expose fresh fixed safe domain errors instead of forwarding
possibly mutated error instances. Do not return provider descriptions or codes
as unchecked public text. HTTP error bodies may be inspected only by the
existing bounded classifier; no new free-text diagnosis or success fallback.

### Diagnostics and cleanup

Use closed operation/stage/category literals and numeric HTTP status, where
known from the actual response. Existing trusted local mailbox/item identifiers
may remain when needed. No raw error object, arbitrary name/code,
message bytes, address, headers, tokens, URLs, cursors or provider-issued IDs
may enter touched send/response/draft-cleanup diagnostics. A preauthenticated
upload URL is a credential even when no Authorization header is attached.
Safe diagnostics use the existing logger, never recursive raw-error logging.
If a diagnostic fails or is disabled, retain that fact internally without
leaking its value, replacing the primary or claiming publication succeeded.

Perform actual owned response cancellation and reader release on success and
failure where needed; attempt later cleanup even if an earlier cleanup or its
diagnostic fails. A cleanup failure cannot replace an established primary or
change a known refusal into another domain diagnosis. Keep response size caps,
timeouts, cancellation ownership, MIME bytes, recipient/thread semantics and
Message-ID preservation intact. This decision neither authorizes a new URL
trust/SSRF policy nor weakens existing address/transport policy.

### Provider acceptance and draft lifetime

Before Graph acknowledges final send, a failure after obtaining a validated
draft id attempts deletion of that owned draft, best effort. Preserve the
primary failure and safely diagnose a failed deletion. If draft creation fails
without a usable id, do not invent one, claim deletion or add an account-wide
janitor. Provider state in that ambiguous case remains unestablished.

Once Graph's actual send endpoint acknowledges acceptance, a subsequent
unneeded response-body cancellation/release or diagnostic failure preserves
the accepted-send result and must not trigger failed-draft deletion or another
submission. No automatic send retry is introduced. This distinguishes a
cleanup problem from a delivery refusal without claiming cleanup succeeded.
Gmail's required success body may fail after HTTP acceptance: that remains a
safe ordinary ambiguous failure, without a fabricated message/thread id,
successful response or automatic retry. Existing returned success shapes stay
unchanged.

## Consequences

Callers intentionally lose unknown send-provider exception identity at the
finite boundary, while the owning layer preserves actual failure evidence
through cleanup. Domain outcomes remain typed and safe; non-provider SQL,
credential and application failures retain their existing semantics.

Tests use real clients/transports/factory with owned fake HTTP providers.
Independently observe producers, owned response/draft cleanup and safe
serialized diagnostics. Cover fetch/body/JSON and upload rejection, secret
message/name/code/nested/non-Error values, combined primary plus cleanup
failure, diagnostic failure, genuine typed refusal and unchanged token-source
failure. Prove deletion on pre-acceptance failure and accepted Graph send
remaining accepted when later cleanup fails. Local tests do not establish live
provider delivery or Message-ID behavior beyond the specified fake contract.

## Alternatives considered

- Rethrow unknown values unchanged: preserves identity but violates the send
  privacy contract and can disclose an upload credential.
- Redact arbitrary error trees by matching tokens or URLs: misses unknown
  encodings and properties, and creates an unbounded generic filter.
- Sanitize every mail/transaction failure at an outer job catch: hides unrelated
  SQL/domain failures and ignores earlier unsafe provider/cleanup logs.
- Treat every failure as reauthorization or retry sending: invents a diagnosis
  and can duplicate an already accepted delivery.
