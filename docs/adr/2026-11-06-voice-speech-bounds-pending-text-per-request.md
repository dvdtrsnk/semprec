---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Bound pending voice speech per synthesis request

## Context

[[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]] streams finished sentences and closes overloaded sessions rather than dropping audio. Gh1734's draft incorrectly retains the whole streamed assistant text and refuses it after 4000 UTF-16 units, even when earlier sentences have drained. The gateway's 4000 limit applies to one synthesis request. Its actual TTS capacity refusal is HTTP503 with code tts_capacity_exhausted, whereas the current HTTP client collapses that into a generic HTTP failure.

This decision bounds only pending speech and adds one TTS-specific typed refusal. It preserves the existing voice wire, per-turn correlation, generic gateway error taxonomy and provider/accounting ownership. It does not change any accepted ADR body or authorize a model diagnostic.

## Capacity classification

In the existing ai-gateway-client httpAiGatewayClient.ts, add SpeechSynthesisCapacityError extending AiGatewayFailedError with reason http and a fixed local name/message. Export it through that package's existing index only. Do not extend the shared AiGatewayFailureReason union, add a generic capacity framework, expose provider text, or change complete/STT errors.

Only synthesizeSpeech may classify HTTP503 with a fully read, valid bounded JSON object whose code is exactly tts_capacity_exhausted as this subtype. Reuse the existing bounded response reader with a 4096-byte cap for this discriminator; retain the existing cancellation/deadline and settle/cancel the owned response on every outcome. Empty, malformed, oversized, unreadable, mismatched code, and another status remain the existing generic HTTP failure. Do not identify capacity from status alone, substring matching or an untrusted prefix before full JSON validation. Budget403/budget_exceeded remains unchanged. No gateway response or provider behavior changes are required.

The voice handler maps this subtype to the existing overloaded frame/close path; other non-budget HTTP failures remain unavailable, and budget stays budgetExceeded. Abort/settle speech resources through existing owners. Existing callers which only recognize AiGatewayFailedError continue to see reason http. An actual local gateway saturation scenario may occupy its configured TTS slots using the already granted provider-transport fixture, then exercise the real client refusal without another model call. Such evidence is TTS/client capacity evidence, not a successful model-to-voice answer.

## Pending text and deduplication

Do not impose a new 4000-unit whole-answer/message cap. Keep an incomplete pending sentence at most 4000 UTF-16 code units, each queued/current synthesis request at most 4000, and at most 32 queued sentences. Process incoming text incrementally, extracting complete sentences before assessing the remaining incomplete buffer. A delta containing several admissible complete sentences is not refused solely because its total exceeds 4000. A single overlong incomplete/sentence or excessive undrained queue closes through overloaded; do not silently truncate, drop text, resample, retry, or add unbounded spill storage. Existing socket/audio/time bounds remain.

For each durable assistant message, track only incremental SHA256 state and an exact UTF-16 code-unit length for the streamed prefix. Feed its code units as UTF-16LE bytes, without normalization; this remains consistent when a surrogate pair is split between deltas. The hash and length are ephemeral, not persisted, logged, sent to the model or exposed over API. No growing heardText copy remains after speech drains.

When the correlated durable text arrives, compare its first tracked-length units with that digest, using a copy/finalization that does not corrupt state before the comparison. If length and hash match, feed only the remaining suffix through the same bounded sentence pipeline. With no streamed prefix, feed the durable text once. On shorter/mismatching text, close unavailable without replaying the whole message or silently discarding an uncertain suffix; already heard audio cannot be retracted. The comparison relies on SHA256 collision resistance, not a new exact character-equality proof. Reset digest/length per durable assistant message, including text-free messages; an unexpected text-free completion after streamed text is unavailable. Do not reset the session's barge-in suppression when resetting a per-message tracker. An interrupted answer remains suppressed until the next queued turn, and suppressed text cannot restart synthesis or trigger spurious mismatch recovery.

This retains bounded state per message and pending request. It is not a promise of unlimited answer length or a new bound on materializing an already stored durable event; existing data/notifier input caps and lifecycle bounds still apply.

## Tests and scope

Use the existing synthesizeSpeech.unit.test.ts for real loopback HTTP status/code, malformed/empty/oversized/mismatched responses, budget preservation, abort/read settlement and subtype/base-class compatibility. The already scoped liveVoiceGateway and voiceSessionHandler.test.ts can prove actual gateway saturation with only provider transport controlled. Do not replace the dispatcher, accounting or model to manufacture wire-success evidence.

A pure text-state helper may be module-exported only from existing voiceSessionHandler.ts for same-service voiceSessionHandler.test.ts contract assertions; no new file, public service barrel, dependency or generic port. Test an answer above4000 with drained sentences, multi-sentence deltas, exact/over4000 pending sentence, queue overflow, matching/mismatching/short durable prefix, split surrogate pairs, per-message reset and barge-in suppression. Observer callbacks may collect helper output; label those as text-state/component tests, not a production pi/worker/socket path.

Production model/answer/barge-in/approval observations remain unproved where the actual worker scenario fails. Keep historical FAIL/UNKNOWN and current local results separate. No new live provider, diagnostic retry, review/final gate, waiver or acceptance follows.
