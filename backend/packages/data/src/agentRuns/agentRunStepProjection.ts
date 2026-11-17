import type { PoolClient } from "pg";
import { listDatabaseLabelsByIds } from "../chokePoint/databasesStore.js";
import { getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { listApprovalRequestStatesByIds, type ApprovalRequestStateView } from "../mcp/approvalRequestsStore.js";
import { countAgentRunToolSteps, type AgentRunEventRange } from "./agentRunEventsStore.js";
import {
  projectAgentRunSteps,
  type AgentRunStep,
  type AgentRunStepDraft,
  type AgentRunStepPage,
  type AgentRunStepTargets,
} from "./agentRunStepPages.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A model writes these ids into its arguments, so they may not be uuids. */
function lookupIds(values: Iterable<string | null>): string[] {
  const ids = new Set<string>();
  for (const value of values) if (value !== null && UUID.test(value)) ids.add(value);
  return [...ids];
}

/**
 * At most three queries regardless of page size. Trashed items are included because a call may have trashed its
 * item. Runs under the caller's tenant scope, so another tenant's id is simply not found.
 */
export async function loadAgentRunStepTargets(
  client: PoolClient,
  steps: readonly AgentRunStepDraft[],
): Promise<AgentRunStepTargets> {
  const itemRows = await getItemsByIdsIncludingDeleted(client, lookupIds(steps.map((step) => step.facts.targetItemId)));
  const labels = await listDatabaseLabelsByIds(
    client,
    lookupIds([...steps.map((step) => step.facts.targetDatabaseId), ...itemRows.map((item) => item.databaseId)]),
  );
  const labelOf = new Map(labels.map((label) => [label.id, label]));
  const items = new Map(
    itemRows.map((item) => {
      const titleKey = labelOf.get(item.databaseId)?.titlePropertyKey;
      const title = titleKey ? item.properties[titleKey] : undefined;
      const fallback = item.properties.name;
      const name = typeof title === "string" ? title : typeof fallback === "string" ? fallback : null;
      return [item.id, { databaseId: item.databaseId, name }] as const;
    }),
  );
  return {
    items,
    databaseModuleIds: new Map(labels.map((label) => [label.id, label.ownerModuleId])),
  };
}

/**
 * A request outside the caller's tenant scope (or a non-uuid id) is missing from the map, so its step has no
 * `approvalState` and the page is still returned.
 */
export async function loadAgentRunStepApprovals(
  client: PoolClient,
  steps: readonly AgentRunStepDraft[],
): Promise<ReadonlyMap<string, ApprovalRequestStateView>> {
  const ids = lookupIds(steps.map((step) => step.approvalRequestId));
  return new Map((await listApprovalRequestStatesByIds(client, ids)).map((request) => [request.id, request]));
}

/**
 * `client` must be inside the run's tenant scope. With `range` the page covers one reply, and an `end` step's
 * tool and approval counts cover that range only.
 */
export async function projectAgentRunStepPage(
  client: PoolClient,
  page: AgentRunStepPage,
  input: { agentRunId: string; locale: string; range?: AgentRunEventRange },
): Promise<{ steps: AgentRunStep[]; nextCursor: string | null }> {
  const targets = await loadAgentRunStepTargets(client, page.steps);
  const counts = page.steps.some((step) => step.kind === "end")
    ? await countAgentRunToolSteps(client, input.agentRunId, input.range)
    : null;
  const approvals = await loadAgentRunStepApprovals(client, page.steps);
  return {
    steps: await projectAgentRunSteps({ steps: page.steps, locale: input.locale, targets, counts, approvals }),
    nextCursor: page.nextCursor,
  };
}
