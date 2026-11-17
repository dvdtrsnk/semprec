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

/** Used when no agent session is wired: the run closes as `error`, not a misleading `done`. */
export const unwiredRunAgent: RunAgentFn = () =>
  Promise.reject(new Error("semprec-agents has no agent session runtime wired"));

/** For calls other than an agent session's own model turns. Throws when `AI_GATEWAY_INTERNAL_TOKEN` is unset. */
export function createAiGatewayClientForAgents(env: NodeJS.ProcessEnv): AiGatewayClientPort {
  const token = env.AI_GATEWAY_INTERNAL_TOKEN;
  if (!token) throw new Error("AI_GATEWAY_INTERNAL_TOKEN is not set");
  return createHttpAiGatewayClient({ port: Number(env.AI_GATEWAY_PORT ?? "3002"), token });
}

/**
 * The actions routed onto `heartbeatFireAgent`. Without `aiGateway`, `core.agentRun` has no
 * `answerExpectedFilter` gate and a heartbeat that turns the gate on fails.
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
