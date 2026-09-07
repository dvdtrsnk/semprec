import { DelegationRegistry, type ReconstructDelegatedHistory } from "./delegationRegistry.js";
import type { CreateAgentSession } from "./types.js";

export interface DelegateToolArgs {
  targetProjectItemId: string;
  task: string;
}

/** Shaped like a pi-agent-core `tool_result` payload: the only thing handed back to Semp's own transcript. */
export interface DelegateToolResult {
  error: boolean;
  result: string;
}

export type DelegateTool = (supervisorRunId: string, args: DelegateToolArgs) => Promise<DelegateToolResult>;

/**
 * `agentTool.delegate` (issue #229): the one tool the supervisor's own manifest carries for
 * running a project agent in-process and getting back only its final assistant message —
 * never the full transcript, and never a subprocess. Project agents must never be handed this
 * tool: that's a hardcoded absence in whatever composition root builds a project agent's tool
 * array (no such root exists yet — #91), not a capability this function itself can be gated
 * behind, since nothing here distinguishes a supervisor caller from a project-agent caller.
 *
 * `createAgentSession` is the target project agent's session factory (already carrying that
 * project's instructions/permission manifest as its `task`/system prompt) — resolving which
 * factory to pass in for a given `targetProjectItemId` is also the composition root's job.
 *
 * `reconstructHistory` defaults to `registry.delegate`'s own always-empty stub when omitted, so
 * a delegated session restarts cold rather than reconstructing (#119) — pass
 * `createReconstructDelegatedHistory(compactionAdapter)` from the composition root to enable it.
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
