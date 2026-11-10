---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Compose live voice evidence through the real gateway and provider adapters

## Context

Gh1734 joins an actual API voice socket, gateway STT upgrade, TTS and an ordinary queued turn. API cannot import a gateway service privately or add an undeclared service dependency. [[2026-11-06-message-speech-accounting-uses-an-isolated-gateway-fixture]] grants a similar bounded compiled fixture to gh1626 only. This record explicitly extends the technique to a separately owned gh1734 fixture; other exceptions are not inherited. [[2026-11-06-voice-turns-share-authorized-run-watch-delivery]] defines the actual authorized watch/barge-in/wire semantics.

## Decision

Create services/semprec-ai-gateway/src/**tests**/fixtures/liveVoiceGateway.ts as an isolated compiled child harness. It composes the existing gateway dispatcher, STT upgrade owner, real OpenAI streaming-transcription and speech-synthesis adapters, runtime-role tenant database pool, budgets and accounting. The API voiceSessionHandler/channel integration test spawns it on owned loopback ephemeral ports, using the real gateway client. It neither imports gateway source into API nor installs a source loader. Reuse the unchanged existing transcribe workspaceDistResolver.mjs only for the allowlisted public compiled workspace packages, with its required unique .batch09- temporary block-model output prefix. Compile only the fixture's required current workspace closure before focused development tests, recording source/artifact hashes, argv and exits. Full verify retains its normal builds. This is test composition, not a production package export or dependency change.

Allow an optional typed WebSocket factory argument on createOpenAiStreamingTranscriptionProvider. Its default is the existing ws constructor, fixed OpenAI URL, auth/options, parser, resampler and lifecycle. The test factory substitutes only the outbound transport by mapping that exact URL to an owned loopback fake provider WebSocket, retaining supplied options and bounding payload/handshake/backpressure. Reject unexpected destinations. Do not inject a fake StreamingTranscriptionProvider, change protocol semantics, expose production endpoint configuration or create a second STT owner. TTS similarly redirects only its outbound HTTP provider transport. The gateway dispatcher, budget/accounting and API client remain actual production owners.

Validate bounded typed child IPC, loopback addresses and runtime role; never emit text/audio/token/database credentials. Settle owned child, servers, WebSockets and pools with observed exits and ordered primary/cleanup errors. No unrelated process cleanup or global fetch modification in the parent; transport redirection stays in the isolated fixture. Existing budget/capacity refusals must be exercised without bypassing accounting.

VoiceSender may gain a typed fail(errorCode) callback routing to the channel's existing private failure/close owner. Error codes stay the existing closed outbound enum; budget uses budgetExceeded and policy close1008. Repeated asynchronous STT/TTS failures/end/close are idempotent and cannot reopen/queue new work. Keep bounded sends/backpressure, actual socket closure, handler cleanup and refusal settlement observed. No direct socket passed to the voice session, second channel, raw reason/error or new wire code.

## Evidence and limits

Actual socket tests cover final/partial transcript, source-voice enqueue, ordinary worker answer/approval, ordered TTS, first-speech barge-in, next queued question, budget frame then close, error/close/deactivation cleanup and no reserved accounting rows. Exercise the real adapter against the bounded fake provider transport and describe synthetic outcomes as such. No live-provider quality, VAD onset or end-to-end human audio comprehension is established. If a specific path is not observed, leave it partial rather than using the speech-cache fixture as implied proof.
