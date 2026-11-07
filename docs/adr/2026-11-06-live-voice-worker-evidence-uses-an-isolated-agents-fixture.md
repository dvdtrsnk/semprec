---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Compose live voice with an isolated actual agents worker

## Context

Gh1734 requires authenticated voice ingestion, an ordinary queued Semp turn, actual run delivery and streamed speech. API tests cannot import the agents service's queue/session factories. A fake worker or manufactured run events can test a socket consumer but cannot establish the requested producer-to-answer path.

[[2026-11-06-live-voice-evidence-composes-real-gateway-transports]] grants gh1734 its gateway-owned speech fixture only. [[2026-11-01-transcription-http-evidence-uses-an-isolated-producer]] supplies the bounded compiled-process pattern. This decision explicitly adds an agents-owned producer and native model transport to the gh1734 composition. It grants no other member's fixture exception and changes no production package boundary.

## Decision

The already scoped services/semprec-api/src/\_\_tests\_\_/voiceSessionHandler.test.ts owns the actual authenticated socket/channel, real voice handler, SyncServer/listener, database setup/assertions, and both child lifecycles. It may spawn the new services/semprec-agents/src/\_\_tests\_\_/fixtures/liveVoiceWorker.ts compiled by the existing agents build. The child imports only its own service's existing production composition and public workspace roots. The API test never imports agents or gateway source, privately or through a new dependency/export.

The worker child verifies a non-superuser/non-BYPASSRLS runtime-role pool, wires actual realtime hooks, loads the actual full module registry, creates the real gateway model and in-flight registry, and registers the actual Semp handler in createAgentsQueueRuntime. Use the existing production heartbeat/agent handler factories when composing other registered tasks. Claim, tenant envelope, ordering, SempConversation, session, ref expansion, pi prompt, tools, event persistence and notifications remain actual production owners. Pass owned Files and mail storage roots through existing LocalFsBlobStorageWriter composition. Do not inject fauxProvider, replace streamFn/model/session/worker, insert fake answer events, manually mark a turn done or grant extra agent capabilities.

This is a task-composition fixture, not the agents serve entrypoint or a deployment proof. It does not run global startup orphan repair against other test work, install process heartbeats, or claim general production startup/exclusivity evidence. It reuses existing task and shutdown/in-flight settlement owners rather than inventing a claim, liveness or unlock protocol. No production source repair, queue affinity change, service manifest or dependency/lock update is authorized.

## Compiled resolution and native gateway

Add only the test-owned services/semprec-agents/src/\_\_tests\_\_/fixtures/liveVoiceWorkerResolver.mjs. It maps exactly @semprec/agent-runtime and @semprec/application to their fixed packages/agent-runtime/dist/index.js and packages/application/dist/index.js roots, then delegates all other resolution to the unchanged transcribe workspaceDistResolver.mjs. These two declared public dependencies are absent from that earlier fixture's allowlist. Do not edit the earlier resolver, map services/deep paths/arbitrary exports, fall back to TypeScript, or change third-party resolution. Register this fixed wrapper before dynamic workspace/service value imports.

The parent may prepare only the required existing workspace/service build closure and the established pure block-model temporary .batch09- emit with its existing compiler overrides. Bind every required artifact to current source/build identity, record argv/exits/hashes, and fail closed on missing/stale output. The new resolver stays a test source .mjs at its exact permanent path; no global loader or production export change. No additional whole-backend build/verify prepass is implied.

The already granted liveVoiceGateway.ts may additionally compose the real piMessagesHandler with the installed native builtinModels and compat streamSimple, independently of its real STT/TTS handlers. The worker's actual createGatewayModel sends HTTP/SSE through it. Redirect only native Anthropic outbound HTTP/SSE to the child-owned loopback provider transport, preserving request method, headers, body, cancellation and provider protocol parsing. Keep speech transport injections exactly as previously authorized. Refuse every unexpected outbound destination. Do not borrow refExpansionGateway or alter production model catalog/auth/config. Safe bounded provider controls can hold/release partial text and a tool cycle; they produce synthetic protocol responses, not model-quality evidence.

## Lifecycle and evidence

Use the same existing ephemeral database under runtime roles, not another database or admin child. Bind listeners to allocated 127.0.0.1 ports; pass credentials privately and never print them. Typed bounded IPC may report readiness, fixed lifecycle states and safe identifiers/counts; it must not carry raw prompt/transcript/answer/audio/base64/provider errors or substitute for the actual task result. Parent messages cannot call a synthetic worker completion handler.

Bound child startup, IPC/output and total test lifetime. Stop new claims through the existing runtime; observe actual in-flight Semp settlement and cleanup failures, close idle sessions/pools through existing owners, and await both child exits before exact owned temporary cleanup. Settle the worker before gateway teardown while model I/O may remain active. Preserve primary and ordered cleanup errors. A failed stop, timer, missing public job or exited wrapper is not proof of successful task/pool/database cleanup. Any necessary final termination is restricted to the exact owned recorded child/group and remains an unsuccessful graceful-cleanup observation, never a pattern kill or inferred DROP success.

Correlate voice source/assistant ids, actual queue job, run id, tenant/project/operation accounting, durable events and real client frames. Prove audio starts before the whole answer using a controlled held native SSE response; prove barge-in suppresses audio while the same queued task continues, and the next final remains ordered. Preserve current approval and authorization behavior; do not create a card manually or widen grants to manufacture an approval pass. If that branch is not reached, report it unproved. An intermediate pi turn_end is not Semp-message completion: observe actual assistant done/error and its correlated final event; reset accumulated text per durable assistant message to avoid repeating earlier segments/tool-cycle text.

The earlier gh1733 original and corrected diagnostic failures remain FAIL with unknown cause. A new gh1734 composed run is a distinct observation on its exact source/artifacts; success would not explain the earlier failures, and a similar failure would not establish a shared cause. If it fails before the model path, keep the combined scenario partial/failed, retain safe target-bound status/accounting observations and continue independent socket/gateway controls. This decision grants no retry of the consumed diagnostic, raw error capture, fake success, production model repair, third review, final verify retry, acceptance or production clearance.
