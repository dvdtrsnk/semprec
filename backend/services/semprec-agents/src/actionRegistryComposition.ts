import type { Pool } from "pg";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import type { AiGatewayClientPort } from "@semprec/shared";
import {
  CORE_AGENT_RUN_ACTION_ID,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
  coreAgentRunAction,
  createActionRegistry,
  createJournalWeeklyCleanupAction,
  createNewEmailAgentRunDependencies,
  type ActionRegistry,
  type RunAgentFn,
} from "@semprec/data";

/**
 * Placeholder `RunAgentFn` until #647 wires a real agent session: `coreAgentRunAction` closes the
 * run it opened as `error` with this message, rather than reporting a misleading `done`.
 */
export const unwiredRunAgent: RunAgentFn = () =>
  Promise.reject(new Error("semprec-agents has no agent session runtime wired"));

/**
 * The HTTP `AiGatewayClientPort` of this process, for the calls that are not an agent session's own model turns
 * (`POST /internal/complete` of `semprec-ai-gateway`, issue #215). Throws when `AI_GATEWAY_INTERNAL_TOKEN` is unset,
 * which `createGatewayModel` already requires of this process.
 */
export function createAiGatewayClientForAgents(env: NodeJS.ProcessEnv): AiGatewayClientPort {
  const token = env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return createHttpAiGatewayClient({ port: Number(env.AI_GATEWAY_PORT ?? "3002"), token });
}

/**
 * The agents runtime's heartbeat `ActionRegistry` (issue #641): `core.agentRun` and
 * `core.journalWeeklyCleanup` (issue #1883), the actions `resolveHeartbeatFireTaskName` routes onto
 * `heartbeatFireAgent`. The weekly Journal cleanup starts its agent run through the `core.agentRun`
 * handler (`coreAgentRunAction` over the same `runAgent`). Issue gh-1941: `core.agentRun` resolves the `mailThreadProject`
 * run project, and `aiGateway` is the client of its `answerExpectedFilter` gate: without it the action has no gate and a
 * heartbeat that turns the gate on fails.
 */
export function createAgentsActionRegistry(
  pool: Pool,
  runAgent: RunAgentFn,
  aiGateway?: AiGatewayClientPort,
): ActionRegistry {
  const registry = createActionRegistry();
  registry.set(
    CORE_AGENT_RUN_ACTION_ID,
    coreAgentRunAction(pool, runAgent, createNewEmailAgentRunDependencies(pool, aiGateway)),
  );
  registry.set(JOURNAL_WEEKLY_CLEANUP_ACTION_ID, createJournalWeeklyCleanupAction(pool, runAgent));
  return registry;
}
