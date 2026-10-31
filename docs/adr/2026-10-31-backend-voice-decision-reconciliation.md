---
status: accepted
date: 2026-10-31
area: [backend]
supersedes: []
superseded-by: null
---

# Reconcile the backend voice decisions and release qualification

## Context

[[2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech]]
records the live voice pipeline and a provisional OpenAI text-to-speech choice.
It specifies a comparative Czech listening test but explicitly says that test
was not performed. [[2026-10-28-dictation-on-device-and-read-aloud-through-the-gateway]]
was written before the voice decision was available in its author's tree and
therefore refers to it without a link. That historical statement describes the
circumstances at the time; both decisions now exist. Their original bodies are
preserved.

## Decision

The live voice decision and the dictation and read-aloud decision are linked
above. Provider calls remain subject to
[[2026-09-10-ai-gateway-monopoly-on-provider-calls]] and tenant and global
budget controls in [[2026-10-16-per-tenant-ai-budgets-with-a-global-safety-cap]].
This addendum does not change either voice contract.

OpenAI TTS remains the provisional engineering default, with ElevenLabs the
alternative documented in the live voice decision. No comparative Czech
listening result has been established. The listening qualification is a
pre-production-release condition tracked by #1399; it is not a prerequisite
for local backend implementation or integration completion. In the historical
voice decision, the adapter "ships" when it is released to production; local
integration does not qualify as shipping. Fake-provider tests cannot establish that qualification. If the qualification changes the
provider decision, record that change through a new decision rather than
rewriting the historical record.

## Alternatives considered

Declaring a winner without the comparative listening test would misrepresent
quality evidence. Blocking local backend engineering until the listening test
would couple reversible integration work to a release qualification; the release
condition retains the unresolved evidence explicitly instead.

## Consequences

- #1399 must retain the unperformed qualification in its acceptance evidence
  and handover until the real comparative test is performed.
- This decision adds no voice route, text-to-speech implementation or client
  dictation work.
