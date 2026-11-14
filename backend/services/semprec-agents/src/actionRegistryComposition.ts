import type { Pool } from "pg";
import {
  CORE_AGENT_RUN_ACTION_ID,
  JOURNAL_WEEKLY_CLEANUP_ACTION_ID,
  coreAgentRunAction,
  createActionRegistry,
  createJournalWeeklyCleanupAction,
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
 * The agents runtime's heartbeat `ActionRegistry` (issue #641): `core.agentRun` and
 * `core.journalWeeklyCleanup` (issue #1883), the actions `resolveHeartbeatFireTaskName` routes onto
 * `heartbeatFireAgent`. The weekly Journal cleanup starts its agent run through the `core.agentRun`
 * handler (`coreAgentRunAction` over the same `runAgent`).
 */
export function createAgentsActionRegistry(pool: Pool, runAgent: RunAgentFn): ActionRegistry {
  const registry = createActionRegistry();
  registry.set(CORE_AGENT_RUN_ACTION_ID, coreAgentRunAction(pool, runAgent));
  registry.set(JOURNAL_WEEKLY_CLEANUP_ACTION_ID, createJournalWeeklyCleanupAction(pool, runAgent));
  return registry;
}
