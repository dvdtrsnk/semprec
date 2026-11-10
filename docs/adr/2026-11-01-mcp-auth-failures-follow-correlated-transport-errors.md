---
status: accepted
date: 2026-11-01
area: [backend]
supersedes: []
superseded-by: null
---

# MCP auth failures follow correlated transport errors

## Context

Gh-1444 requires classifying HTTP 401/403 as auth failures without trusting server
error text. The pinned MCP SDK can discard that typed status when an SSE POST
fails. Its fetch is also used for connection setup, initialized notifications,
OAuth discovery/retries and SSE stream activity. A connection-wide last status
could label an unrelated error, successful retry or timeout as auth.

[[2026-10-16-connect-time-outbound-address-checks]] still governs outbound access.
[[2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls]] still governs
approval execution. This decision changes diagnostic observation only.

## Decision

Keep HTTP responses and the SDK's auth/retry flow unchanged. Do not throw early
on an observed 401/403, consume response bodies, wrap or alter successful
responses, parse exception messages for status, or change credentials/policy.

Use private per-connection, per-transport-operation observation. Identify the
actual MCP request/send, including initialize, initialized notification and
tools/call, and the initial SSE start where applicable. Correlate checked HTTP
metadata to the original error from that exact rejected operation. A private
weak error map or equivalent non-retaining binding may expose a checked optional
reader through the existing client handle; no process-global last-status flag,
public endpoint or new package dependency is introduced.

Record only minimal request identity and checked status, never body, arguments,
response text, credential or provider message. Close observation when its
operation settles; unrelated or later background activity cannot mutate it.
Recursive retries use child attempt scopes; a parent must not overwrite a child
error mapping. Clear superseded observations.
A recovered auth challenge, accepted POST followed by a JSON-RPC/tool error, or
unrelated GET/OAuth response cannot supply stale auth to another rejection.
Consider auth-flow failures separately from successful challenge recovery;
network/policy failures must not inherit an earlier HTTP denial.

The fallback is conservative and pinned to demonstrated SDK terminal branches:
SSE POST 403, or 401 without an OAuth provider, with the same emitted and rejected
Error identity and a matching attempt. Preserve callback chaining and original
method this/options. A callback throwing a replacement error, ambiguous request,
body/network failure or uncertain identity supplies no inferred auth status.
A 401 with a provider, or a 403 upscoping challenge, is not itself a terminal auth
failure. Successful retries and unrelated OAuth/discovery/provider failures must
not inherit that challenge. Use explicit typed auth errors where available;
otherwise retain the existing non-auth fallback rather than invent causality.
Initialize and initialized-notification POSTs require their own separately tested
ownership; do not generalize this inference to arbitrary notifications or GETs.

Consult observation only after the corresponding operation actually rejects.
Preserve the original SDK error propagation and existing safe result text.
Cancellation, explicit request/connect timeout and outbound-address denial keep
their precedence. Typed SDK authentication errors remain usable directly; the
adapter fills erased status rather than replacing existing classification.

A local helper may implement this boundary inside the data MCP package. Keep its
state and lifecycle private and validate any SDK-derived identity used for
correlation. No raw error content is emitted in diagnostics or persisted failure
metadata, and no additional outbound request or retry is introduced.

## Alternatives

- Parsing the SDK error message trusts provider-controlled content and is not a
  typed HTTP signal.
- Throwing from fetch on 401/403 bypasses the SDK's challenge/retry semantics.
- A last-status flag per connection or broad call phase can race stream/OAuth
  work and can outlive a successful retry or independent request timeout.
- Changing the SDK or its responses widens the integration contract beyond the
  required diagnostic behavior.

## Consequences

The adapter must follow the pinned transport's error and retry ownership. Tests
must use real local SSE/StreamableHTTP paths for 401/403 after handshake and the
relevant setup stages, plus recovered challenges, superseding non-auth failures,
unrelated stream activity, cancellation/timeouts and address-policy refusal.
Concurrent connection cases prove isolation. Capture fixed diagnostics with
sensitive sentinels; do not infer absence of Error content from JSON.stringify.
Tests use owned fixtures, existing test-only loopback policy and bounded cleanup;
no live provider or production connectivity claim is authorized.

This is a scoped backend delivery decision. It is not a general HTTP error
framework or an authorization exception. The implementing batch must supply
reviewed code and exact runtime evidence before claiming this contract holds.
