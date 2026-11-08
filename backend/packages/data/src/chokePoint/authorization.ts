// Owns the actor-type authorization boundary for view and `view_items` writes: the `Actor`
// identity a write is checked against, verification that an `ai_agent` actor names a real
// Projects item, and the rule that an agent may only write views it created. It does not own
// the view writes themselves (viewOps.ts), database-level guards (databaseGuards.ts), or
// per-user ownership checks (there is a single human user).
// Constrained by:
// - docs/adr/2026-09-10-agent-identity-verified-against-projects-items.md
// - docs/adr/2026-09-10-views-are-excluded-from-the-agent-proposal-flow.md
import type { PoolClient } from "pg";
import { ForbiddenError } from "../errors.js";
import type { CreatedBy, ViewRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * The caller identity every view/view_items write is checked against (issue #87). `type`
 * mirrors `CreatedBy` (the write's intended kind); `agentProjectItemId` is the server-derived
 * owning Projects item id for an authenticated agent caller — required when `type ===
 * 'ai_agent'`, never present otherwise, and never accepted from a request body (it is set only
 * by whatever authenticates the caller, upstream of the choke-point).
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
 * Every agent-actor write (view row or `view_items` membership) proves its identity before
 * touching any row: a missing `agentProjectItemId` or one that names no real Projects item is
 * rejected outright, so a cross-agent or legacy-owner check never runs against a forged or
 * dangling identity. A no-op for a 'user'/'system' actor.
 * See [[2026-09-10-agent-identity-verified-against-projects-items]] for why this is a live
 * lookup rather than an FK (partitioned `items` can't express one).
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

/** Shared by patch/delete on a view and every write to its `view_items` membership. A no-op for a 'user'/'system' actor — only an agent write is ownership-checked here. */
export function assertViewWritable(view: ViewRow, actor: Actor): void {
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
