---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Observe message speech accounting through an isolated gateway fixture

## Context

Gh-1626 requires an authenticated message-speech request and its actual ai_gateway_calls accounting, including cache reuse and budget refusal. Its API-owned handler test cannot import another deployable service under the no-service-to-service dependency rule. A fake gateway HTTP listener would exercise transport without proving real authentication, admission, reservation and settlement.

[[2026-11-01-transcription-http-evidence-uses-an-isolated-producer]] already defines a bounded compiled child-fixture mechanism. This decision explicitly applies that mechanism to this member and names its exact owner paths; no permission is inferred from an earlier batch's test exceptions.

## Decision

The existing services/semprec-api/src/**tests**/sempSpeechHandler.test.ts owns the real API dispatcher, authenticated request/session, storage roots and assertions. It may spawn only the new gateway-owned services/semprec-ai-gateway/src/**tests**/fixtures/messageSpeechGateway.ts compiled by that service's existing build. The child imports its own production gateway dispatcher and OpenAI speech adapter, and public data/shared seams. The API test does not import gateway service code, public or private, and no package manifest, lockfile, dependency rule, export or production composition changes are needed for the harness.

Inject only outbound provider transport: the production OpenAI adapter's fixed speech URL is redirected to an owned loopback provider fixture that returns bounded PCM, delays or fails as directed by closed test controls. Reject unexpected outbound destinations rather than falling through to live traffic. The real API HTTP client, internal authentication, tenant parsing, TTS handler, validation and accounting stores execute unchanged. Other dispatcher provider ports may fail if unexpectedly reached; they are not substitutes for the exercised synthesis owner. Do not inject a fake accounting owner, gateway dispatcher, cache store or API handler.

The child shares the existing ephemeral PostgreSQL database using the actual non-superuser/non-BYPASSRLS runtime-role connection passed privately through its environment. It verifies the runtime role before serving. Do not spawn a new database, modify auth configuration or print connection strings/tokens. Both gateway and provider listeners bind only 127.0.0.1 with allocated ports. Typed bounded IPC reports readiness, safe provider-call observations and finite release/failure/stop controls; no raw text/audio/token enters frames or logs. Unknown or oversized controls fail closed.

Explicitly reuse the unchanged test-only resolver services/semprec-transcribe/src/**tests**/fixtures/workspaceDistResolver.mjs. This is registration of a fixed test loader path by the child, not an import of another service's production code. It maps only its existing allowlisted public workspace entry points to built JavaScript and never maps service internals, deep exports, source fallbacks or arbitrary package names. The API test may emit only the existing pure block-model project to an exact owned temporary directory matching the resolver's existing .batch09- prefix contract, with the existing noEmit/declaration/incremental overrides, then pass that exact built entry privately to the child. The resolver itself, shared sources/config and dependency graph remain unchanged.

Required current service/package artifacts must exist and be bound to source/build identities before the child starts. Targeted development tests may build the necessary packages and gateway service once as preparation; full verification already builds them before integration. Missing or stale artifacts fail rather than silently importing source. Capture compiler/child argv, PID, actual exit and hashes without credentials. This scoped fixture preparation is not an extra whole-backend verification pass or proof of production deployment/package resolution.

## Lifecycle and evidence

The parent bounds child startup, IPC/output and run time, captures its own child identity/group and observes exit. Close HTTP servers, outstanding connections/streams and child pools in dependency order before exact owned temporary cleanup. Preserve the original test error and cleanup errors, and do not claim an exited child or released database merely because a timer expired. No pattern-kill, unrelated process cleanup, fixed shared temporary path, global loader installation or ignored artifact deletion is authorized.

Exercise first authenticated cache miss, repeated hit and overlapping first requests through the API's actual listener and real client to the child gateway. Bind before/after runtime-role accounting rows to the tenant and voice_synthesize operation: one successful miss has one actual settled call and audio duration, a cache hit adds none, and same-key overlap adds one. Include actual budget refusal and a provider/stream failure with reservation settlement and no false completed cache. Keep owner/foreign/random no-call controls and API response/body checks. Unrelated pre-existing rows are not attributed merely by total count; synthetic provider transport and finite session schedules are labeled honestly.

The existing source Task/AC and separately pinned final-gate/review budget remain. A fake HTTP gateway may support a separately labeled client transport test, but it cannot satisfy the accounting AC. No live provider, listening-quality result, deployed topology, provider exactly-once guarantee or package-boundary exception is claimed.
