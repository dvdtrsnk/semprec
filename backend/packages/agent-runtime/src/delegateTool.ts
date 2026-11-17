import { DelegationRegistry, type ReconstructDelegatedHistory } from "./delegationRegistry.js";
import type { CreateAgentSession } from "./types.js";

export interface DelegateToolArgs {
  targetProjectItemId: string;
  task: string;
}

/** The only thing handed back to Semp's transcript. */
export interface DelegateToolResult {
  error: boolean;
  result: string;
}

export type DelegateTool = (supervisorRunId: string, args: DelegateToolArgs) => Promise<DelegateToolResult>;

/**
 * `agentTool.delegate`: runs a project agent in-process and returns only its final assistant message, never the full
 * transcript. Project agents must never be given this tool; that is enforced by the composition root that builds their
 * tool array, since nothing here can tell a supervisor caller from a project agent.
 *
 * `createAgentSession` is the target project's session factory, chosen by the composition root. `reconstructHistory`
 * defaults to the always-empty stub, so a delegated session restarts cold unless
 * `createReconstructDelegatedHistory(compactionAdapter)` is passed.
 */
export function createDelegateTool(
  registry: DelegationRegistry,
  createAgentSession: CreateAgentSession,
  reconstructHistory?: ReconstructDelegatedHistory,
): DelegateTool {
  return async function delegate(supervisorRunId, args) {
    const outcome = await registry.delegate({
      createAgentSession,
      supervisorRunId,
      targetProjectItemId: args.targetProjectItemId,
      task: args.task,
      reconstructHistory,
    });

    return outcome.ok ? { error: false, result: outcome.message ?? "" } : { error: true, result: outcome.error };
  };
}
