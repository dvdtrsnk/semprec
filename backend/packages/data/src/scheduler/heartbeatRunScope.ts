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
 * What the heartbeat agent tools may reach for one run (issue #2018): `project` is the run's own
 * project; `tenant` is every project of the tenant minus the ones the sensitive rule leaves out
 * (`getHeartbeatVisibleToChatRun`), and carries the run's project, which that rule compares grants against.
 */
export interface HeartbeatReadScope {
  scope: "project" | "tenant";
  projectItemId: string;
}

/**
 * The scope of the calling run, derived from persisted rows only, never from tool arguments: `tenant` when
 * the run's `agent_runs.thread_id` points at a Semp thread of kind `chat` (a delegated run inherits the thread,
 * issue #1452), otherwise `project`. A run without a thread, or on an `item` or `tick` thread, keeps the own
 * project. `null` when the run is unknown or has no project.
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

/**
 * One heartbeat by id inside `readScope`, in one statement: an id that is unknown, belongs to another project
 * (a `project` scope) or tenant, or is left out by the sensitive rule (a `tenant` scope) gives the same `null`.
 */
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

/**
 * The project item `projectItemId` when it is a live item of the tenant's Projects database, otherwise `null`:
 * an unknown id, an item of another database, a trashed project and another tenant's project give the same answer.
 */
export async function findLiveProject(client: PoolClient, projectItemId: string): Promise<ItemRow | null> {
  const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  // A tenant without its Projects database is a seeding fault, not a missing project.
  if (!projects) throw new Error(`Projects module database not found for module ${PROJECTS_MODULE_ID}`);
  const item = await getItemById(client, projects.id, projectItemId);
  return item && item.deletedAt === null ? item : null;
}

/**
 * Throws `NotFoundError` ("Project <id> not found", the answer for a project that does not exist) for a project
 * the run may not create automations in (issue #1846): any project but its own for a `project` scope, and for a
 * `tenant` scope a project the sensitive rule leaves out (`isProjectReachableByChatRun`), the same rule that
 * hides its heartbeats from the run's reads. Whether the project exists is checked separately (`findLiveProject`).
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
