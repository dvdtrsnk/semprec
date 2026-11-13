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

/** The ids a page's calls name that can be looked up: a model writes them into its arguments, so one may not be a uuid. */
function lookupIds(values: Iterable<string | null>): string[] {
  const ids = new Set<string>();
  for (const value of values) if (value !== null && UUID.test(value)) ids.add(value);
  return [...ids];
}

/**
 * Resolves what the calls of one page point at, in a constant number of queries however many steps the page
 * holds (at most three): the items by id, trashed ones included since a call may have trashed its item, and
 * the labels of the databases the page names or the items are in. Both reads run under the caller's tenant
 * scope, so an id of another tenant is simply not found. An item's name is its `title` property, else its
 * `name`, and `null` when neither is text.
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
 * The approval requests of the page's approval steps by id, in one query (none when the page has no
 * approval step). A request the caller's tenant scope cannot read, or whose id is no uuid, is not in the
 * map, so its step has no `approvalState` and the page is still returned.
 */
export async function loadAgentRunStepApprovals(
  client: PoolClient,
  steps: readonly AgentRunStepDraft[],
): Promise<ReadonlyMap<string, ApprovalRequestStateView>> {
  const ids = lookupIds(steps.map((step) => step.approvalRequestId));
  return new Map((await listApprovalRequestStatesByIds(client, ids)).map((request) => [request.id, request]));
}

/**
 * A page of a run's steps ready for the route (issues #1847 and #1862): `page` from `buildAgentRunStepPage`,
 * each step with its localized title and summary, its target's name and its change, and an approval step
 * with the live state of its request. `locale` is the session user's `users.locale`. The caller's `client`
 * must be inside the tenant scope of the run. With `range` (issue #1889) the page belongs to one reply of the
 * run, and the tool and approval counts of an `end` step cover that range only.
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
