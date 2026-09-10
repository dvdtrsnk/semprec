# agent-runtime

Owns one thing: mapping a `pi-agent-core` (pinned as the `@earendil-works/pi-*`
packages) agent session's lifecycle onto Semprec's persisted `agent_runs` /
`agent_run_events` audit trail, plus the in-memory reuse/reconstruction
policies (`DelegationRegistry`, `SempConversation`, `conversationReconstruction.ts`,
`compaction.ts`) and the outbound MCP tool-call adapter (`mcpInvokeTool.ts`)
built on top of that mapping. It does not decide _what_ an agent is allowed to
do, which tools a module contributes, or who may talk to a model provider —
those are other packages'/services' jobs, on purpose, and this doc is the
boundary between them.

This is a compatibility boundary, not an implementation detail: code outside
this package must depend only on what `src/index.ts` exports and on the
`CreateAgentSession`/`AgentSession`/`PiProviderRegistry` ports in `src/types.ts`
and `src/piProviders.ts`, never on a specific lifecycle file or on
`pi-agent-core`/a provider SDK directly. Both are enforced by
`dependency-cruiser.rules.json` (`no-agent-runtime-internal-cross-import`,
`no-agent-runtime-provider-internals`) — see
[Enforced boundaries](#enforced-boundaries).

## Ownership map

Five responsibilities the runtime is built around, and which package/service
owns each. Only the second is this package.

| Responsibility                                                            | Owner                                                                                           | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-run lifecycle & compaction                                         | `pi-agent-core` (external, pinned as `@earendil-works/pi-agent-core`/`pi-ai`/`pi-coding-agent`) | Runs one agent turn to completion, streams its messages, decides when/how to compact context. Opaque to this package — reached only through the `CreateAgentSession` port and the `CompactionAdapter` seam (`compaction.ts`); the one sanctioned direct import is `src/__tests__/piRuntimeContract.unit.test.ts`, which pins the exact version and shape this package is written against.                                                                                                          |
| Session audit (`agent_runs` / `agent_run_events`, `unit`)                 | **this package** (`agent-runtime`)                                                              | `lifecycleAdapter.ts` opens/closes `agent_runs` rows and appends `agent_run_events`; `startupRepair.ts` closes orphans left `running` by a crash; `delegationRegistry.ts`/`sempConversation.ts` add TTL-bounded, key-scoped reuse of an already-open session, with `conversationReconstruction.ts` rebuilding a dormant session's prior context on wake; `mcpInvokeTool.ts` is the outbound MCP tool-call adapter agent turns use to actually call a granted tool.                                 |
| Semprec orchestration (trigger acceptance, startup ordering, tool wiring) | `services/semprec-agents` (not yet built — issue #91)                                           | Decides _when_ a run starts (heartbeat/delegation/user message), which `CreateAgentSession` factory and `systemPromptOverride` a given caller gets, calls `registerPiProviders` once at startup, and calls `repairInterruptedRuns` before accepting new triggers. `services/semprec-api` exists today but only reads persisted state (`agent_runs`, approval requests, AI usage) over HTTP — it does not construct or drive a session, so it is not this composition root.                         |
| Gateway egress & budget                                                   | `packages/ai-gateway`                                                                           | The only package allowed to hold provider credentials or call a model API; `gateway.ts`'s `complete`/`embed`/`transcribe` check the daily/monthly budget caps before every call and log `ai_gateway_calls`. See `.bb/skills/ai-gateway/SKILL.md`. `piProviders.ts`'s `registerPiProviders` is how a `pi-agent-core` session is routed through it instead of a provider directly.                                                                                                                   |
| Registry allowlist (which tools a module contributes)                     | `packages/module-registry`                                                                      | `ModuleAgentToolDescriptor`/`ModuleAgentToolProjection` — a module declares its agent tools once, in its manifest; nothing here decides that list. MCP tools follow the same "declared, not decided here" shape one level down: `packages/data`'s `mcpSync.ts` (human-triggered "Synchronize tools") and `mcpProjectGrantsStore.ts`/`mcpAgentTools.ts` (per-project grants) decide what's grantable and granted — `mcpInvokeTool.ts` here only resolves and executes against whatever it's handed. |

A maintainer looking for "who owns X":

- A run stuck at `running` after a crash → `startupRepair.ts`.
- A message missing from a run's transcript → `runAgentTurn` in
  `lifecycleAdapter.ts` (persisted-kind filter, insert order).
- A delegated call returning "already handling another request" →
  `delegationRegistry.ts`'s busy/TTL bookkeeping.
- Semp's own conversation not resuming context after a pause →
  `sempConversation.ts` and `conversationReconstruction.ts`.
- An MCP tool call rejected before it reaches the server, or stuck pending
  human approval → `mcpInvokeTool.ts` (`resolveMcpInvocation`,
  `createApprovalGatedMcpInvokeTool`).
- A tool available to the wrong agent, which tools a module/MCP server
  contributes, or a model call bypassing the budget → not this package; see
  `module-registry`, `packages/data`'s `mcp/` sources, and `ai-gateway` above.

## SOLID mapping

**SRP** — each file owns one axis of the lifecycle and nothing else:
`lifecycleAdapter.ts` (one turn's event bookkeeping + one run's open/close),
`startupRepair.ts` (crash recovery only, no runtime participation),
`delegationRegistry.ts` / `sempConversation.ts` (session reuse policy, built
_on_ `runAgentTurn` rather than duplicating it), `conversationReconstruction.ts`
(rebuilding a dormant session's prior context, nothing else), `compaction.ts`
(the four narrow `estimateContextTokens`/`shouldCompact`/`prepareCompaction`/
`compact` seams, opaque otherwise), `piProviders.ts` (routing pi's providers
through the gateway at startup, nothing about a specific session), and
`mcpInvokeTool.ts` (resolving + executing one MCP tool call, optionally
approval-gated). None of them decide tool availability, and only
`mcpInvokeTool.ts` writes anywhere outside `agent_runs`/`agent_run_events` —
and there, only `approval_requests`, which is that file's whole reason to
exist.

**OCP** — the two extension points a caller uses to change an agent's
behavior without editing this package: `systemPromptOverride` (`(defaultPrompt:
string) => string`, threaded from `RunAgentSessionInput`/`SempConversationOptions`
down to `AgentSessionOptions`) and the tool array a `CreateAgentSession`
factory closes over before it's ever passed in here. Neither requires a
change in `lifecycleAdapter.ts`, `delegationRegistry.ts`, or `sempConversation.ts`.

**LSP** — `runAgentSession`, `DelegationRegistry.delegate`, and
`SempConversation.send` all construct a session the same way, through the
same `CreateAgentSession` port and the same `runAgentTurn` event loop, whether
the caller is a supervisor delegating to a project agent or a project agent
running standalone. A project agent's session is substitutable anywhere a
supervisor's session is expected — same construction, same audit shape —
because the port makes no distinction between them; only the _task_/system
prompt a caller supplies differs.

**ISP** — this package never sees a whole tool catalog, only whatever the
composition root already filtered down to a specific `CreateAgentSession`
closure, or a single already-resolved MCP tool a caller names by
`mcpToolRegistrationId`. Nothing here inspects or types the full tool array,
requires a supervisor capability check (`delegateTool.ts`'s docstring is
explicit that supervisor-vs-project-agent tool availability is a hardcoded
absence in the not-yet-built composition root, not something this package
gates), or decides which MCP tools exist — `mcpSync.ts` (explicit,
human-triggered "Synchronize tools") and the grants stores in `packages/data`
own that, one level below `module-registry`'s manifest allowlist.
`mcpInvokeTool.ts` is where per-call approval actually lives in this package:
`resolveMcpInvocation` re-derives authorization from server-held grant state
(never from the model's own `args`) before touching a transport, and
`createApprovalGatedMcpInvokeTool` inserts an `approval_requests` row and
returns a pending-approval result instead of executing when
`target.requiresApproval` — matching `backend/review-rules/tasks/architecture.md`
rule 7's "write goes through the approval queue" requirement. `runAgentTurn`
itself still just persists whatever `tool_use`/`tool_result` messages arrive;
the gate is `mcpInvokeTool.ts`'s, not the turn loop's.

**DIP** — every runtime file in this package depends on the
`CreateAgentSession`/`AgentSession` port (`types.ts`), the `CompactionAdapter`
port (`compaction.ts`), or the `PiProviderRegistry` port (`piProviders.ts`),
never on `pi-agent-core`'s or a provider's own package. `AgentSession.send` is
optional specifically so the port doesn't assume every implementation
supports multi-turn continuation. `types.ts`'s own comment says why the ports
exist rather than the real SDK: `pi-agent-core` has not published TypeScript
types yet, so these interfaces are the contract a real `createAgentSession`
must satisfy once it ships a matching shape. `pi-agent-core` _is_ now a real,
pinned dependency (`@earendil-works/pi-agent-core`/`pi-ai`/`pi-coding-agent`)
— issue #134's `piRuntimeContract.unit.test.ts` is the one file allowed to
import it directly, precisely to catch a pinned-version drift between the
real package and the ports above before it reaches runtime code; every other
file stays written against the port, not the concrete import. The
package-local `check-pi-import-paths` script (`pnpm run check:pi-import-paths`)
is the complementary check one level down: it doesn't police _whether_
`src/` imports pi, it fails any import that reaches past a pinned package's
public root into an internal or example path.

## Enforced boundaries

`pnpm run check:boundaries` (from `backend/`) runs `dependency-cruiser`
against `modules`, `services`, and `packages`. Two rules in
`dependency-cruiser.rules.json` are specific to this package:

- `no-agent-runtime-internal-cross-import` — nothing outside
  `packages/agent-runtime` may import a file under `src/` other than
  `index.ts`. A caller reaching for `lifecycleAdapter.ts` or
  `delegationRegistry.ts` directly fails the check.
- `no-agent-runtime-provider-internals` — nothing under
  `packages/agent-runtime/src/`, except `src/__tests__/`, may import
  `@earendil-works/pi-*` or `@anthropic-ai/*` directly. The exclusion is
  exactly `piRuntimeContract.unit.test.ts`'s sanctioned pin check described
  under DIP above — every other file stays on the port.

Both are additive to the pre-existing `no-module-service-internal-cross-import`
rule, which covers `modules/*` and `services/*` the same way but deliberately
leaves `packages/*` unrestricted in general — these two rules are a
package-specific exception for `agent-runtime` because its responsibility
split is the compatibility boundary this doc exists to protect, not a
change to that general policy.

`pnpm run check:pi-import-paths` (`scripts/check-pi-import-paths.mjs`) is a
narrower, complementary check scoped to this package alone: it doesn't gate
_whether_ a file may import a pi package (that's the dependency-cruiser rule
above), only that an import which does reach one stops at that package's
public root instead of an internal or example path pi hasn't committed to
keeping stable across patch releases.
