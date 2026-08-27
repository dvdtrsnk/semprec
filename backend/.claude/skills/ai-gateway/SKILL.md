---
name: ai-gateway
description: How to call LLMs and AI providers from Semprec backend code. Use this skill whenever code needs a model call of any kind — chat completion, transcription (Whisper/DeepInfra), diarization (pyannoteAI), embeddings, or a new provider — and also when tempted to import a provider SDK, add a provider API key, or make a direct HTTP call to a model API from anywhere.
---

# AI calls go through semprec-ai-gateway. All of them.

`semprec-ai-gateway` is the single process allowed to talk to AI providers. Every
other package, service, module, and script makes AI calls only through the
gateway's internal contract.

Why one door:
- **Cost control.** The gateway checks the dual budget caps (`dailyBudgetUsd`,
  `monthlyBudgetUsd` in Semprec settings) *before* the call and refuses when
  exceeded. A direct provider call is an uncapped spend.
- **Observability.** Every call is logged to `ai_gateway_calls` (tokens, cost,
  caller, purpose) — this feeds `GET /api/ai-usage` and the utilization graph.
  A bypassed call is invisible money.
- **Credential containment.** Provider API keys live only in the gateway's own
  environment. If any other process held them, a compromise anywhere would leak
  them; this way the blast radius is one process.
- **Swappability.** Providers (Anthropic, DeepInfra, pyannoteAI, …) are gateway
  adapters behind one contract — callers never know or care which vendor serves
  them (dependency inversion is the point of the gateway's design).

## Rules

- Never import a provider SDK (`@anthropic-ai/*`, `openai`, …) outside the
  gateway package. Never `fetch` a model API URL outside it.
- Never read or define a provider API key (env var, config, DB) outside the
  gateway's environment.
- Pass a `purpose`/caller identifier with every gateway call so
  `ai_gateway_calls` rows stay attributable.
- Expect and handle the gateway's budget-refusal response — surface it (e.g. as
  `agent_run_error` / a notification), don't retry-loop against a closed budget.
- Adding a new capability (new model, new provider)? Extend the gateway with a
  new adapter behind the existing contract — don't create a side channel, even
  "temporarily".

## Litmus test

If the diff adds a dependency on a vendor, a key, or an HTTP call to a model URL
and the file isn't inside the gateway — stop; move that code into a gateway
adapter and call it through the contract instead.
