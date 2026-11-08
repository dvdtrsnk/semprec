---
status: accepted
date: 2026-11-02
area: [backend]
supersedes: []
superseded-by: null
---

# Bearer sync failures stay private

## Context

Gh-1505 and gh-1508 prohibit tokens and client secrets in Gmail/Graph sync
errors and logs. Their REST clients attach Authorization to an injected fetch.
Fetch, JSON body consumption and Graph's later attachment stream can reject
with arbitrary values that include that token. The job records an error's text
and rethrows it, so safe refresh errors alone do not protect the provider path.

[[2026-11-02-smtp-and-imap-sync-isolate-secret-bearing-provider-failures]] and
[[2026-11-02-mail-verification-sanitizes-unknown-failures-at-its-public-boundary]]
explicitly limit their exceptions to other boundaries. Apply the same privacy
principle to the finite sync surfaces below through a separate decision.

## Decision

After token acquisition, isolate actual fetch and body-read failures inside
GmailRestClient.request, GraphRestClient.request and Graph's lazy sync attachment
fetch/stream. Keep original rejection values, explicit presence (including
undefined), source and observation order within the operation owner through its
owned settlement, cleanup and diagnostic processing. At the client boundary,
unknown provider failures become fresh fixed generic Errors without raw cause,
properties or aggregate members. No known auth/unreachable diagnosis is inferred.
Neither outward error text nor diagnostics may contain tokens, headers, raw
responses, arbitrary error names/codes, URLs, cursors or provider-supplied IDs.
Use fixed operation/category tags and actual numeric HTTP status where needed.

Keep getAccessToken outside these provider catches. Its refresh, persistence,
commit and typed rejection contracts remain unchanged. No broad wrapper around
reconcile, the job, SQL, ingest or blob storage is authorized. Preserve actual
HTTP semantics: Gmail's 404/null and history invalidation; Graph's typed 404
attachment metadata refusal and 410 delta invalidation; known size caps and
existing timeout/abort settings. Keep those trusted status branches distinct
from arbitrary fetch/body rejections; do not classify thrown lookalike objects
as an HTTP response. This is not a response-schema redesign.

Graph well-known-folder discovery may continue for an actual GraphApiError 404
only. An unknown network/body error, token-acquisition failure or other status
must fail the operation, not silently become an absent optional folder. This
narrowly corrects the existing blanket catch so newly protected failures are
not swallowed. Preserve legitimate missing-folder behavior and test both sides.

Graph's attachment source must forward a fixed safe upstream failure to the
returned stream, retain the original internally through its owned stream cleanup,
and release source/transform resources on upstream failure and consumer teardown.
Keep stream observers until actual terminal settlement. Do not sanitize an
independent downstream storage/SQL exception or feed it back as a falsely
classified network failure. Preserve bytes, streaming, backpressure and cap
behavior; do not buffer whole attachments, add retries or continue after failure.
JSON read/parse failures receive the same safe projection; newly generated
request/attachment diagnostics use fixed contexts rather than raw request URLs.

Use the existing logger, if a diagnostic is emitted, with closed fixed fields
only. Preserve primary/secondary identities internally, including cleanup or
diagnostic failure, without a public raw-error seam, durable error store,
recursive logging or false successful-publication claim. Actual owned cleanup
still runs. The existing job can record/rethrow the safe provider error; its
failure writer and non-network errors keep their existing semantics.

## Consequences

The reused REST clients intentionally lose unknown sync-provider exception
identity at their privacy boundary. A generic infrastructure failure remains
failure rather than a misleading reauthorization or unreachable result. This
does not alter write/send/upload endpoints, OAuth token acquisition, address
policy, transaction boundaries or other transport contracts.

Tests cover real client calls through the configured API sync adapters and job,
fetch rejection, JSON/body rejection, Gmail lazy attachment request and Graph
late attachment-stream failure/consumer teardown. Independently observe original
producers and cleanup, then assert safe outward errors, stored last_error and
serialized application/queue diagnostics. Include undefined/non-Error, nested
secret-bearing failures, cleanup failures, genuine HTTP 404/410, missing-folder
versus other failure, unchanged refresh rejection and unchanged SQL/domain/
storage error identities. Use owned fake providers; no live service evidence
is established by this decision.
