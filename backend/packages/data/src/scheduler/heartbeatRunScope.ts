import type { Pool, PoolClient } from "pg";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { NotFoundError } from "../errors.js";
import {
  getHeartbeatForProject,
  getHeartbeatVisibleToChatRun,
  isProjectReachableByChatRun,
  type HeartbeatRow,
} from "./schedulerStore.js";
import type { HeartbeatRuleKindRegistry } from "./rule.js";

/**
 * What the heartbeat agent tools may reach for one run: `project` is the run's own project; `tenant` is
 * every project except those the sensitive rule excludes, and carries the run's project for that rule.
 */
export interface HeartbeatReadScope {
  scope: "project" | "tenant";
  projectItemId: string;
}

/**
 * Derived from persisted rows only, never from tool arguments: `tenant` when the run's thread is a Semp
 * `chat` thread (delegated runs inherit it), otherwise `project`. `null` for an unknown or projectless run.
 */
export async function resolveHeartbeatReadScope(
  client: Pool | PoolClient,
  currentRunId: string,
): Promise<HeartbeatReadScope | null> {
  const run = await getAgentRun(client, currentRunId);
  if (!run?.projectItemId) return null;
  if (run.threadId === null) return { scope: "project", projectItemId: run.projectItemId };
  const { rows } = await client.query<{ is_chat: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM semp_threads WHERE id = $1 AND kind = 'chat') AS is_chat",
    [run.threadId],
  );
  return { scope: rows[0]?.is_chat === true ? "tenant" : "project", projectItemId: run.projectItemId };
}

/** One statement; unknown, out-of-scope and excluded ids all give the same `null`. */
export function findHeartbeatInScope(
  client: Pool | PoolClient,
  readScope: HeartbeatReadScope,
  heartbeatId: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
): Promise<HeartbeatRow | null> {
  return readScope.scope === "tenant"
    ? getHeartbeatVisibleToChatRun(client, readScope.projectItemId, heartbeatId, moduleRuleKinds)
    : getHeartbeatForProject(client, readScope.projectItemId, heartbeatId, moduleRuleKinds);
}

/** Unknown ids, other databases' items, trashed projects and other tenants' projects all give `null`. */
export async function findLiveProject(client: PoolClient, projectItemId: string): Promise<ItemRow | null> {
  const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  // A tenant without its Projects database is a seeding fault, not a missing project.
  if (!projects) throw new Error(`Projects module database not found for module ${PROJECTS_MODULE_ID}`);
  const item = await getItemById(client, projects.id, projectItemId);
  return item && item.deletedAt === null ? item : null;
}

/**
 * Throws `NotFoundError` (same message as a missing project) for a project the run may not create
 * automations in: any but its own for a `project` scope; for `tenant`, one the sensitive rule excludes.
 * Existence is checked separately (`findLiveProject`).
 */
export async function requireProjectInRunScope(
  client: Pool | PoolClient,
  readScope: HeartbeatReadScope,
  projectItemId: string,
): Promise<void> {
  const reachable =
    readScope.scope === "project"
      ? readScope.projectItemId === projectItemId
      : await isProjectReachableByChatRun(client, readScope.projectItemId, projectItemId);
  if (!reachable) throw new NotFoundError(`Project ${projectItemId} not found`);
}
