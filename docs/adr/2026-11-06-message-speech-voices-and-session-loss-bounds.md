---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Pin message speech voices and bound session-loss claims

## Context

Gh-1626 requests a closed API voice list and an ADR-defined default, but [[2026-10-28-dictation-on-device-and-read-aloud-through-the-gateway]] and [[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]] select a provisional provider without selecting a voice. The current gateway adapter accepts eleven voice names. Provider choice alone does not select a default and is not listening-quality evidence.

[[2026-11-06-message-speech-cache-brackets-gateway-io]] holds a guard session separately from the connection used by withTransaction. Its statement that a session error prevents persistence needs a narrower observable boundary: COMMIT may already be in flight on the other connection. This decision narrows that statement; the earlier accepted ADR bodies remain unchanged.

## API voice contract

The exact case-sensitive values accepted by the message-speech endpoint are alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer and verse. The default is alloy, selected only when the voice parameter is absent. An empty, unknown, case-changed or repeated voice parameter is HTTP 400 through the existing ValidationError contract with details.field equal to voice, before provider or cache-fill effects. Do not silently trim, lowercase or substitute an invalid name.

Keep one API-owned literal list and default in the already-scoped sempSpeechHandler.ts. Its handler tests verify the default, every listed value, invalid input and the cache identity of absent voice versus explicit alloy. Gh-1734 may reuse that same local API contract for its default synthesis instead of introducing another independent default. There is no private cross-service import, provider SDK dependency, new shared package or gateway catalog mutation. These API values are a deliberately pinned contract; a new provider voice is not automatically accepted just because a provider adds it.

The names currently designate the pinned OpenAI gpt-4o-mini-tts voices, with language inferred from message text by the existing provider call. No language parameter or listening result is invented. This clarifies the earlier read-aloud ADR's abstract voice identity for this concrete API: plain API names have a fixed provider/model/automatic-language interpretation here. Any future provider/model/language-policy remapping must explicitly revise that interpretation and prevent reuse of incompatible old cache entries; it must not silently reuse an old name for different audio. No speculative mapping registry or cache migration is added now. The provisional provider choice and unperformed Czech listening test remain open production evidence, not a local implementation blocker or a passed quality gate.

## HTTP budget response

The authenticated message-speech listener maps only the existing typed gateway budget refusal to HTTP 403 with the exact JSON body {"error":{"code":"budget_exceeded"}} and no provider content. This is that bespoke endpoint's response contract, not an addition to the generic item error taxonomy. Other failures must not be classified as budget exhaustion. Gh-1734 continues mapping the same internal budget condition to its separately pinned budgetExceeded WebSocket code. Test actual authenticated endpoint status/body and no cache fill, plus a non-budget failure that is not mislabeled.

## Observable guard loss and commit uncertainty

Observe guard-session failures throughout the fill, abort external work, and check the recorded failure immediately before the final managed transaction callback returns. A loss observed before that callback completes must reject it, rolling back its writes. Do not change db/pool.ts, issue manual transaction commands or add fencing merely to claim a stronger guarantee.

A loss after the callback returns, a COMMIT already in flight, or a connection loss not yet observed can still permit a cache commit. The guard is not a fence. Do not claim every guard-session loss prevents persistence, that abort cancels an issued COMMIT, or that a failed client response proves rollback. The source row reservation, exact source-text revalidation and unique cache key still arbitrate database results. After an uncertain outcome, reread the cache/blob state through its owner when possible. Never delete staged audio that may belong to a committed row. If the database cannot establish absence, retain the private bytes and report uncertainty; do not mask the primary failure or invent a successful cleanup.

This is the same explicit no-exactly-once-after-session-loss boundary as the preceding ADR, with its observable timing made precise. A later claimant may repeat provider work; no lease takeover, automatic retry, transactional callback/COMMIT hook or global pool behavior change is introduced. Prove an observed pre-finalization failure has no cache, and preserve an already committed row's bytes under a finite lost-acknowledgement control. Synthetic connection/acknowledgement failures are labeled as such, not proof of a real network partition or provider exactly-once behavior.
