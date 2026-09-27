import type { Pool } from "pg";
import {
  CORE_AGENT_RUN_ACTION_ID,
  coreAgentRunAction,
  createActionRegistry,
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
 * The agents runtime's heartbeat `ActionRegistry` (issue #641): exactly `core.agentRun`, the one
 * action `resolveHeartbeatFireTaskName` routes onto `heartbeatFireAgent`.
 */
export function createAgentsActionRegistry(pool: Pool, runAgent: RunAgentFn): ActionRegistry {
  const registry = createActionRegistry();
  registry.set(CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction(pool, runAgent));
  return registry;
}
