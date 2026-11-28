import type { Pool } from "pg";
import type { ModuleRegistry } from "@alldots/module-registry";
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
 * `undefined` when no registry is configured, the run or project is gone, or the tool is no longer offered
 * (inactive module, revoked capability, or dropped from the manifest).
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
 * The caller holds the execution claim. In order:
 * 1. A tool no longer offered is `toolUnavailable`; the handler does not run.
 * 2. A snapshot hash that differs from the stored one (or appeared/disappeared) is `sourceChanged`; an
 *    unreadable snapshot is `callFailed`. The handler does not run.
 * 3. Otherwise the handler runs once. Its error result or throw is `callFailed`; a throw is logged but its message
 *    is not stored.
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
 * Records the outcome `queued`-guarded, posts the outcome message and announces, in one transaction. An outcome
 * for an already-settled request is discarded and logged.
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
