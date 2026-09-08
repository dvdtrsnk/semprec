# agent-runtime

Owns one thing: mapping a `pi-agent-core` agent session's lifecycle onto
Semprec's persisted `agent_runs` / `agent_run_events` audit trail, and the two
in-memory reuse policies (`DelegationRegistry`, `SempConversation`) built on
top of that mapping. It does not decide *what* an agent is allowed to do, what
tools it carries, or who may talk to a model provider — those are other
packages'/services' jobs, on purpose, and this doc is the boundary between
them.

This is a compatibility boundary, not an implementation detail: code outside
this package must depend only on what `src/index.ts` exports and on the
`CreateAgentSession`/`AgentSession` port in `src/types.ts`, never on a
specific lifecycle file or on `pi-agent-core`/a provider SDK directly. Both
are enforced by `dependency-cruiser.rules.json` (`no-agent-runtime-internal-
cross-import`, `no-agent-runtime-provider-internals`) — see
[Enforced boundaries](#enforced-boundaries).

## Ownership map

Five responsibilities the runtime is built around, and which package/service
owns each. Only the first is this package.

| Responsibility | Owner | What it is |
| --- | --- | --- |
| Single-run lifecycle & compaction | `pi-agent-core` (external) | Runs one agent turn to completion, streams its messages, decides when/how to compact context. Opaque to this package — reached only through the `CreateAgentSession` port. |
| Session audit (`agent_runs` / `agent_run_events`, `unit`) | **this package** (`agent-runtime`) | `lifecycleAdapter.ts` opens/closes `agent_runs` rows and appends `agent_run_events`; `startupRepair.ts` closes orphans left `running` by a crash; `delegationRegistry.ts`/`sempConversation.ts` add TTL-bounded, key-scoped reuse of an already-open session on top of the same turn-running primitive (`runAgentTurn`). |
| Semprec orchestration (trigger acceptance, startup ordering, tool wiring) | `services/semprec-agents` (not yet built — issue #91) | Decides *when* a run starts (heartbeat/delegation/user message), which `CreateAgentSession` factory and `systemPromptOverride` a given caller gets, and calls `repairInterruptedRuns` before accepting new triggers. |
| Gateway egress & budget | `services/semprec-ai-gateway` (not yet built) | The only process allowed to hold provider credentials or call a model API; enforces the daily/monthly budget caps and logs `ai_gateway_calls`. See `backend/.claude/skills/ai-gateway/SKILL.md`. `pi-agent-core` sessions call through it, never around it. |
| Registry allowlist (which tools a module contributes) | `packages/module-registry` | `ModuleAgentToolDescriptor`/`ModuleAgentToolProjection` — a module declares its agent tools once, in its manifest; nothing here decides that list. |

A maintainer looking for "who owns X":
- A run stuck at `running` after a crash → `startupRepair.ts`.
- A message missing from a run's transcript → `runAgentTurn` in
  `lifecycleAdapter.ts` (persisted-kind filter, insert order).
- A delegated call returning "already handling another request" →
  `delegationRegistry.ts`'s busy/TTL bookkeeping.
- Semp's own conversation not resuming context after a pause →
  `sempConversation.ts`'s `reconstructHistory` seam (stubbed until #119).
- A tool available to the wrong agent, or a model call bypassing the budget →
  not this package; see `module-registry` and `semprec-ai-gateway` above.

## SOLID mapping

**SRP** — each file owns one axis of the lifecycle and nothing else:
`lifecycleAdapter.ts` (one turn's event bookkeeping + one run's open/close),
`startupRepair.ts` (crash recovery only, no runtime participation),
`delegationRegistry.ts` / `sempConversation.ts` (session reuse policy, built
*on* `runAgentTurn` rather than duplicating it). None of them import a
provider SDK, decide tool availability, or write anywhere but `agent_runs` /
`agent_run_events`.

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
because the port makes no distinction between them; only the *task*/system
prompt a caller supplies differs.

**ISP** — this package never sees a whole tool catalog, only whatever the
composition root already filtered down to a specific `CreateAgentSession`
closure. Nothing here inspects or types the tool array, requires a supervisor
capability check (`delegateTool.ts`'s docstring is explicit that supervisor-
vs-project-agent tool availability is a hardcoded absence in the not-yet-built
composition root, not something this package gates), or reaches into
`module-registry`'s manifest. Per-call approval (state-writes going through a
proposal/`confirm` flow — see `backend/review-rules/tasks/architecture.md`
rule 7) is likewise a caller concern: `runAgentTurn` persists whatever
`tool_use`/`tool_result` messages arrive, it does not gate them.

**DIP** — every file in this package depends on the `CreateAgentSession` /
`AgentSession` port (`types.ts`), never on `pi-agent-core`'s or a provider's
own package. `AgentSession.send` is optional specifically so the port doesn't
assume every implementation supports multi-turn continuation. `types.ts`'s
own comment says why the port exists rather than the real SDK: `pi-agent-core`
has not published TypeScript types yet, so this interface is the contract a
real `createAgentSession` must satisfy once it ships a matching shape — this
package is written against the port, not the eventual concrete import.

## Enforced boundaries

`pnpm run check:boundaries` (from `backend/`) runs `dependency-cruiser`
against `modules`, `services`, and `packages`. Two rules in
`dependency-cruiser.rules.json` are specific to this package:

- `no-agent-runtime-internal-cross-import` — nothing outside
  `packages/agent-runtime` may import a file under `src/` other than
  `index.ts`. A caller reaching for `lifecycleAdapter.ts` or
  `delegationRegistry.ts` directly fails the check.
- `no-agent-runtime-provider-internals` — nothing under
  `packages/agent-runtime/src/` may import `pi-agent-core` or `@anthropic-ai/*`
  directly. Once `pi-agent-core` is added as a real dependency somewhere in
  this repo, this rule is what keeps that import out of this package instead
  of the `CreateAgentSession` port.

Both are additive to the pre-existing `no-module-service-internal-cross-import`
rule, which covers `modules/*` and `services/*` the same way but deliberately
leaves `packages/*` unrestricted in general — these two rules are a
package-specific exception for `agent-runtime` because its responsibility
split is the compatibility boundary this doc exists to protect, not a
change to that general policy.
