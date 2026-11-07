---
status: accepted
date: 2026-11-06
area: [backend]
supersedes: []
superseded-by: null
---

# Observe Inbox proposal contracts through a shared isolated gateway fixture

## Context

Gh1643 validates page-content envelopes and preserves background clarification on invalid computations. Gh1649 changes the model-facing v2 contract and resolves heading text after target selection. A stub AiGatewayClientPort can test local parsing but cannot establish the actual client, gateway schema validation and accounting path. Data-package tests cannot import an API service backwards, and an API test cannot import another deployable gateway service.

[[2026-11-06-message-speech-accounting-uses-an-isolated-gateway-fixture]] applies the compiled isolated-producer mechanism to gh1626 only. This decision expressly applies the same mechanism to gh1643 and gh1649, sharing one exact fixture for their related structured-completion observations. Earlier member-local fixtures do not grant general permission.

## Decision

The existing services/semprec-api/src/\_\_tests\_\_/proposalComputation.test.ts owns this composition. It invokes its real createProposalComputation and the existing public createSemprecTickAction from @semprec/data, with real tenant-scoped capture/type owners and managed transactions. No data test imports the API service, and no test fabricates proposal system fields or sourceInbox edges to claim real tick production. Existing direct data-owner tests remain separately labeled.

The API test may spawn only the new services/semprec-ai-gateway/src/\_\_tests\_\_/fixtures/inboxProposalGateway.ts, compiled by the existing gateway build. This child composes the actual gateway dispatcher, completeHandler, authentication, tenant validation, structured-output schema validation, budget reservation/settlement and createAnthropicStructuredProvider. The actual API HTTP gateway client remains in use. Unused gateway operations fail closed if reached; no production computation, client, dispatcher, provider algorithm or accounting store is replaced.

Inject only outbound provider HTTP transport: redirect the native Anthropic structured provider's fixed messages URL to an owned loopback provider listener, preserve request method/body/headers and cancellation, and refuse unexpected destinations instead of reaching live traffic. Return bounded synthetic provider protocol responses for the named v2, legacy and invalid-output cases. Validate the actual received instructions/schema and safe semantic fields without printing text, credentials or full payloads. Synthetic provider responses prove deterministic protocol composition, not model quality.

Explicitly reuse only the unchanged test resolver services/semprec-transcribe/src/\_\_tests\_\_/fixtures/workspaceDistResolver.mjs. Its existing fixed public-workspace entry allowlist maps to compiled JavaScript, never service-private imports, arbitrary packages or source fallbacks. The API test may compile only the existing pure block-model project to an exact owned temporary .batch09- directory with the resolver's established noEmit/declaration/incremental overrides. No package manifest, lockfile, dependency rule, production export or global loader change is authorized. All required compiled artifacts must be source/build-bound and present before launch; fail closed on missing/stale artifacts. Record bounded preparatory build argv, exit and artifact hashes; preparation is not another full verify.

## Lifecycle and observations

Both child listeners bind allocated 127.0.0.1 ports. Pass the existing ephemeral database's non-superuser/non-BYPASSRLS runtime role privately; verify that role before serving. Do not create another database or print connection strings/tokens. Typed bounded IPC exposes readiness, finite response modes, safe counts/sentinel flags and stop only. Bound startup, output, IPC and run time. Capture exact owned child/group identities and exits; settle HTTP streams/connections, servers and child pools before owned temporary cleanup. Preserve primary and cleanup errors. No pattern kills, unrelated resource cleanup, abandoned child or inferred DROP success is permitted.

Gh1649 observes actual outbound v2 instructions/schema, accepted legacy output and real tick conversion to a target heading id or end, preserving start/end and excluding stored afterHeadingText. Gh1643 observes shared validator/revise status400 separately from the actual eligible tick's invalid-output needsClarification/null-envelope result, including existing stale/locked guards. Attribute accounting observations to the actual tenant/project/operation and isolated scenario; a count across unrelated rows is insufficient. Keep synthetic-provider, direct-owner and real composed observations distinct. Existing unrelated stub-based tests may remain local tests but do not become model-path proof.

The two members have their own recorded permission to this shared fixture. No gh1733/gh1752 diagnostic retry, other member exception, live provider, production clearance, final-gate retry or acceptance follows. Existing Task/AC, review budget and separately pinned final verification remain in force.
