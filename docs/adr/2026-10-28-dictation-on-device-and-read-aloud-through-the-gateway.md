---
status: accepted
date: 2026-10-28
area: [backend, mobile]
supersedes: []
superseded-by: null
---

# Dictation on the device, read-aloud through the gateway

## Context

Semp chat needs speech in two places outside the live voice mode: reading one
stored answer aloud (read-aloud), and dictating text into the message field
without starting an agent turn (dictation). Each can run on the device (the
Apple speech synthesizer and Apple Speech recognition) or through the AI
gateway, which would reuse the streaming speech adapters of #1396 and #1399
and count against the tenant's AI budget (`ai_gateway_calls.audio_seconds`).
The backend has neither today.

Relevant decisions: [[2026-09-10-ai-gateway-monopoly-on-provider-calls]] (every
provider call goes through the gateway), [[2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap]]
(per-tenant budgets), and the live voice mode ADR that #1371 will record,
including its Czech text-to-speech listening test. That ADR does not exist yet;
this ADR will reference it by slug once #1371 lands. Czech is the primary
language for both features.

## Decision

### Dictation runs on the device

Dictation uses the device's speech recognition (Apple Speech) in Czech. The
audio stays on the device and is never sent to the backend. No dictation
endpoint is built, and the backend has no dictation code path, budget entry or
audit row. The result is plain text that the client places in the message field;
it reaches the backend only as an ordinary message the user sends.

Rejected alternative: transcription through the gateway (the #1399 adapter).
It would send every dictated utterance to a provider, cost tenant budget and add
a network round trip to what is a typing aid, for a quality gain that was not
needed for short Czech phrases.

### Read-aloud runs through the gateway

Read-aloud uses the same high-quality Czech text-to-speech provider as the live
voice mode (OpenAI TTS or ElevenLabs, as chosen by the Czech listening test
recorded in the ADR of #1371). Provider calls go only through the gateway, as
required by [[2026-09-10-ai-gateway-monopoly-on-provider-calls]]. #1626 builds
the endpoint.

Rejected alternative: the on-device synthesizer. It is free, instant and works
offline, but its Czech voice quality is below the live voice mode, so one answer
would sound different depending on how it was started. Quality outweighs cost
here because read-aloud is an explicit, per-message user action.

Rules for the gateway variant:

- Synthesized audio is cached per message and voice. The cache key is the
  stored message identity plus the voice (which includes the provider and
  language); a repeat request for the same pair is served from the cache with
  no provider call. Editing the message text yields a different message
  version, so stale audio is not served for changed text.
- A cache miss is a gateway call. It is recorded in `ai_gateway_calls` with its
  `audio_seconds` and counts against the tenant's budget under
  [[2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap]]. A cache hit
  costs nothing and records no call.
- When the budget is exhausted the gateway refuses the call as for any other
  model call; the client may then fall back to the on-device synthesizer, which
  is a client decision and not a backend behavior.

## Trade-offs

| | Dictation (device) | Read-aloud (gateway) |
|---|---|---|
| Quality | Adequate for short Czech phrases | Matches live voice mode |
| Cost | None | Tenant budget, reduced by the cache |
| Latency | Local | Network plus synthesis on a cache miss |
| Offline | Works when the device supports on-device recognition | Needs the backend on a cache miss |
| Audio privacy | Microphone audio never leaves the device | Only stored message text leaves, to the provider, through the gateway |

## Consequences

- Backend: no dictation work. Read-aloud work is limited to #1626, which
  builds on the speech adapters of #1396 and #1399, the per-message-and-voice
  cache and the budget accounting above.
- The Apple client uses device speech recognition for dictation and requests
  the speech permissions that requires; that client work is outside this ADR.
- Switching dictation to the gateway later would need a new ADR, an endpoint
  and a budget decision for microphone audio; it is not implied here.
