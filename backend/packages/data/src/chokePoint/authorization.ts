// The actor-type authorization boundary for view and `view_items` writes: the `Actor` identity,
// verification that an `ai_agent` names a real Projects item, and that an agent may only write views
// it created. There is a single human user, so no per-user ownership checks.
import type { PoolClient } from "pg";
import { ForbiddenError } from "../errors.js";
import type { CreatedBy, ViewRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * `type` mirrors `CreatedBy`. `agentProjectItemId` is the server-derived Projects item of an
 * authenticated agent: required when `type === 'ai_agent'`, never present otherwise, and never
 * accepted from a request body.
 */
export interface Actor {
  type: CreatedBy;
  agentProjectItemId?: string;
}

function ownerViolation(view: { id: string }, reason: string): ForbiddenError {
  return new ForbiddenError(
    `View ${view.id} write rejected by owner_violation: ${reason}`,
    { field: "creatorProjectItemId", viewId: view.id, reason },
    "owner_violation",
  );
}

/**
 * A view carrying `config.systemKey` is read-only for every actor, so a client-set key would mint an
 * undeletable view or squat a seed's `(database_id, systemKey)` slot. `createView`/`patchView` refuse
 * the key unless the actor is `system`; seeds write through `viewsStore.createView`. Presence is the
 * test, not the value.
 */
export function assertSystemKeyWritable(config: Record<string, unknown> | undefined, actor: Actor): void {
  if (actor.type === "system" || config === undefined || !Object.hasOwn(config, "systemKey")) return;
  throw new ForbiddenError(
    "config.systemKey is reserved for system views and cannot be set by a client",
    { field: "config.systemKey", reason: "system_key_reserved" },
    "owner_violation",
  );
}

/**
 * A missing or dangling `agentProjectItemId` is rejected before any row is touched, so ownership
 * checks never run against a forged identity. A live lookup rather than an FK because partitioned
 * `items` cannot carry one. No-op for a 'user'/'system' actor.
 */
export async function assertAuthenticatedAgentIdentity(client: PoolClient, actor: Actor): Promise<void> {
  if (actor.type !== "ai_agent") return;
  if (!actor.agentProjectItemId) {
    throw new ForbiddenError(
      "An agent actor requires actor.agentProjectItemId",
      { field: "agentProjectItemId", reason: "missing_authenticated_agent_identity" },
      "owner_violation",
    );
  }
  const projectsDatabase = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  if (!projectsDatabase) {
    throw new ForbiddenError(
      "The Projects system database does not exist, so no agent identity can be verified",
      { field: "agentProjectItemId", reason: "unknown_authenticated_agent_identity" },
      "owner_violation",
    );
  }
  const projectItem = await itemsStore.getItemById(client, projectsDatabase.id, actor.agentProjectItemId);
  if (!projectItem || projectItem.deletedAt) {
    throw new ForbiddenError(
      `Projects item ${actor.agentProjectItemId} does not exist`,
      { field: "agentProjectItemId", reason: "unknown_authenticated_agent_identity" },
      "owner_violation",
    );
  }
}

/**
 * Shared by view patch/delete and every `view_items` write. A view with a `systemKey` is refused for
 * every actor as `system_owned`; otherwise only an agent write is ownership-checked.
 */
export function assertViewWritable(view: ViewRow, actor: Actor): void {
  if (Object.hasOwn(view.config, "systemKey")) throw ownerViolation(view, "system_owned");
  if (actor.type !== "ai_agent") return;
  switch (view.createdBy) {
    case "system":
      throw ownerViolation(view, "system_owned");
    case "user":
      throw ownerViolation(view, "user_owned");
    case "ai_agent":
      if (view.creatorProjectItemId === null) throw ownerViolation(view, "legacy_creator_unknown");
      if (view.creatorProjectItemId !== actor.agentProjectItemId) throw ownerViolation(view, "creator_mismatch");
      return;
    default: {
      const exhaustive: never = view.createdBy;
      throw new Error(`Unhandled CreatedBy value: ${String(exhaustive)}`);
    }
  }
}
