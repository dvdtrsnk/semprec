---
status: accepted
date: 2026-09-10
area: [backend]
supersedes: []
superseded-by: null
---

# Only `semprec-ai-gateway` may talk to AI providers

## Context

Semprec calls AI providers for chat completion, transcription
(Whisper/DeepInfra), diarization (pyannoteAI), and embeddings, from several
services and modules. Each caller importing a provider SDK directly would
mean cost caps, usage logging, and provider credentials are each
reimplemented (or forgotten) per caller.

## Decision

`semprec-ai-gateway` is the single process allowed to talk to AI providers.
Every other package, service, module, and script makes AI calls only
through the gateway's internal contract. Concretely:

- No provider SDK import (`@anthropic-ai/*`, `openai`, …) or direct
  provider HTTP call outside the gateway package.
- No provider API key read or defined outside the gateway's environment.
- Every gateway call carries a `purpose`/caller identifier for
  attributable logging.
- A new capability (new model, new provider) is a new adapter behind the
  gateway's existing contract, never a side channel.

## Consequences

- **Cost control**: the gateway checks `dailyBudgetUsd`/`monthlyBudgetUsd`
  before every call and refuses over budget — a direct provider call would
  be uncapped spend.
- **Observability**: every call is logged to `ai_gateway_calls`, feeding
  `GET /api/ai-usage`; a bypassed call is invisible money.
- **Credential containment**: provider keys live only in one process's
  environment, so a compromise anywhere else can't leak them.
- **Swappability**: callers depend on the gateway's contract, not on a
  vendor, so switching or adding providers doesn't touch callers.
- An LLM/AI-provider call anywhere outside the gateway is a critical review
  finding (`review-rules/rules.md`,
  `review-rules/tasks/architecture.md`) — it silently defeats all four
  properties above at once.
