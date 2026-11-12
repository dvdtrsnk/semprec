import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { resolveModuleAgentToolsForRun, type ResolvedModuleAgentTool } from "../agentTools/moduleAgentTools.js";
import { describeModuleToolFailure } from "../agentTools/describeModuleToolFailure.js";
import { postApprovalOutcomeMessage } from "./approvalOutcomeMessage.js";
import { publishApprovalRequestChange } from "./approvalRequestRealtime.js";
import {
  recordApprovalRequestOutcome,
  type ApprovalRequest,
  type ApprovalRequestOutcome,
  type ModuleToolApprovalRequestPayload,
} from "./approvalRequestsStore.js";
import { logger } from "./logger.js";

/**
 * The tool as the requesting run can use it now, or `undefined` when it cannot: no registry is
 * configured, the run or its project is gone, or the tool is not offered to the run any more (its
 * module is inactive, its capability is no longer granted, or the manifest no longer declares it).
 */
async function findModuleTool(
  pool: Pool,
  registry: ModuleRegistry | undefined,
  request: ApprovalRequest,
  toolName: string,
): Promise<ResolvedModuleAgentTool | undefined> {
  if (!registry) return undefined;
  const run = await withTransaction(pool, (client) => getAgentRun(client, request.agentRunId));
  if (!run?.projectItemId) return undefined;
  const tools = await resolveModuleAgentToolsForRun(pool, registry, run.id, run.projectItemId, undefined, {
    includeApprovalGated: true,
  });
  return tools.find((tool) => tool.name === toolName);
}

/**
 * What becomes of one claimed module-tool request (issue #1791). The caller holds the execution
 * claim, so no other delivery gets here for this request. In order:
 * 1. The tool is looked up again through `ModuleRegistry` for the requesting run; a tool that is not
 *    offered any more is a `toolUnavailable` error outcome and the handler does not run.
 * 2. The tool's snapshot is read again and compared with the hash stored when the request was
 *    created; a different hash (also a snapshot that appeared or disappeared) is a `sourceChanged`
 *    error outcome and the handler does not run. A snapshot that cannot be read is a `callFailed`
 *    error outcome and the handler does not run.
 * 3. Otherwise the handler runs once with the stored arguments. Its own error result, and anything
 *    it throws, are a `callFailed` error outcome; the throw is logged, and its message is not stored.
 */
async function moduleToolOutcome(
  pool: Pool,
  registry: ModuleRegistry | undefined,
  request: ApprovalRequest,
  payload: ModuleToolApprovalRequestPayload,
): Promise<ApprovalRequestOutcome> {
  const tool = await findModuleTool(pool, registry, request, payload.moduleToolName);
  if (!tool) {
    return {
      error: true,
      outcomeKind: "toolUnavailable",
      result: "This module tool is no longer available to the requesting run, so it did not run.",
    };
  }
  let currentSnapshot: string | null;
  try {
    currentSnapshot = await tool.snapshotOf(payload.args);
  } catch (err) {
    logger.error(
      { ...describeModuleToolFailure(err), approvalRequestId: request.id, toolName: payload.moduleToolName },
      "Module tool approval snapshot could not be read",
    );
    return {
      error: true,
      outcomeKind: "callFailed",
      result: "The source snapshot of this module tool call could not be read, so it did not run.",
    };
  }
  if (currentSnapshot !== request.resourceSnapshot.sha256) {
    return {
      error: true,
      outcomeKind: "sourceChanged",
      result: "The source of this module tool call changed after the request was created, so it did not run.",
    };
  }
  try {
    const invoked = await tool.invoke(payload.args);
    return invoked.error ? { ...invoked, outcomeKind: "callFailed" } : invoked;
  } catch (err) {
    logger.error(
      { ...describeModuleToolFailure(err), approvalRequestId: request.id, toolName: payload.moduleToolName },
      "Approved module tool call failed",
    );
    return {
      error: true,
      outcomeKind: "callFailed",
      result: "The module tool failed. It may have changed part of its source before it stopped.",
    };
  }
}

/**
 * Settles one module-tool request that `claimApprovalRequestExecution` just claimed (issue #1791):
 * works out its outcome (`moduleToolOutcome`), then, in one transaction, records it guarded on the
 * request still being `queued`, posts the outcome message into the requesting thread and announces
 * the change. An outcome that finds the request already settled by another path is discarded and
 * logged, like the MCP outcome in `handleApprovalRequestExecuteTask`.
 */
export async function executeClaimedModuleToolApproval(
  pool: Pool,
  registry: ModuleRegistry | undefined,
  claimed: ApprovalRequest,
  payload: ModuleToolApprovalRequestPayload,
): Promise<void> {
  const outcome = await moduleToolOutcome(pool, registry, claimed, payload);
  const recorded = await withTransaction(pool, async (client) => {
    const changed = await recordApprovalRequestOutcome(client, claimed.id, outcome);
    if (changed) {
      await postApprovalOutcomeMessage(client, claimed, outcome.error ? "conflict" : "executed");
      await publishApprovalRequestChange(client, claimed);
    }
    return changed;
  });
  if (!recorded) {
    logger.warn(
      { approvalRequestId: claimed.id },
      "Module tool approval outcome discarded: the request was already settled by another delivery",
    );
  }
}
