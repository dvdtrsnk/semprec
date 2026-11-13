import type { Pool, PoolClient } from "pg";
import { GuidanceReferenceNotFoundError } from "@semprec/shared";
import type {
  GuidanceReferenceStore,
  ProjectAgentGuidance,
  ProjectAgentGuidanceStore,
  TransactionRunner,
} from "@semprec/shared";
import { requireSingleRow, withTransaction } from "./db/pool.js";
import { NotFoundError } from "./errors.js";
import { getDatabaseByModuleId } from "./chokePoint/databasesStore.js";
import { getItemById } from "./chokePoint/itemsStore.js";
import { getTenantUserId, getUserById } from "./auth/usersStore.js";
import { PROJECTS_MODULE_ID } from "./seed/tenDatabaseKeys.js";
import { projectAgentGuidanceVersionStore } from "./projectAgentGuidanceVersionStore.js";
import { publishProjectAgentInvalidation } from "./projectAgent/projectAgentInvalidation.js";

type ProjectAgentGuidanceRow = {
  project_item_id: string;
  owner_user_id: string;
  markdown: string;
  updated_at: Date;
};

function mapRow(row: ProjectAgentGuidanceRow): ProjectAgentGuidance {
  return {
    projectItemId: row.project_item_id,
    ownerUserId: row.owner_user_id,
    markdown: row.markdown,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function lockGuidance(tx: PoolClient, projectItemId: string): Promise<ProjectAgentGuidanceRow | null> {
  await projectAgentGuidanceVersionStore.lock(tx, projectItemId);
  const { rows } = await tx.query<ProjectAgentGuidanceRow>(
    `SELECT project_item_id, owner_user_id, markdown, updated_at
     FROM project_agent_guidance WHERE project_item_id = $1 FOR UPDATE`,
    [projectItemId],
  );
  return rows[0] ?? null;
}

/** Concrete `PoolClient` implementation of `@semprec/shared`'s `ProjectAgentGuidanceStore`. */
export const projectAgentGuidanceStore: ProjectAgentGuidanceStore<PoolClient> = {
  async loadForUpdate(tx, projectItemId) {
    const row = await lockGuidance(tx, projectItemId);
    return row ? mapRow(row) : null;
  },
  async delete(tx, projectItemId) {
    const current = await lockGuidance(tx, projectItemId);
    if (!current) throw new NotFoundError(`Project agent guidance for project ${projectItemId} not found`);
    await projectAgentGuidanceVersionStore.remember(tx, projectItemId, current.updated_at);
    const result = await tx.query("DELETE FROM project_agent_guidance WHERE project_item_id = $1", [projectItemId]);
    if (result.rowCount !== 1) throw new NotFoundError(`Project agent guidance for project ${projectItemId} not found`);
    publishProjectAgentInvalidation(tx, projectItemId);
  },
  async load(tx, projectItemId) {
    const { rows } = await tx.query<ProjectAgentGuidanceRow>(
      `SELECT project_item_id, owner_user_id, markdown, updated_at
       FROM project_agent_guidance WHERE project_item_id = $1`,
      [projectItemId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async upsert(tx, row) {
    // `owner_user_id` is deliberately absent from `DO UPDATE`: only `transfer` may change the
    // owner of an existing row, so a direct `upsert` call can never bypass that authorization
    // path even though it still accepts `ownerUserId` to seed the very first insert.
    const current = await lockGuidance(tx, row.projectItemId);
    const version = await projectAgentGuidanceVersionStore.next(tx, row.projectItemId, current?.updated_at ?? null);
    const { rows } = await tx.query<ProjectAgentGuidanceRow>(
      `INSERT INTO project_agent_guidance (project_item_id, owner_user_id, markdown, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_item_id)
       DO UPDATE SET markdown = EXCLUDED.markdown, updated_at = EXCLUDED.updated_at
       RETURNING project_item_id, owner_user_id, markdown, updated_at`,
      [row.projectItemId, row.ownerUserId, row.markdown, version],
    );
    publishProjectAgentInvalidation(tx, row.projectItemId);
    return mapRow(requireSingleRow(rows, "project_agent_guidance upsert"));
  },

  async transfer(tx, projectItemId, newOwnerUserId) {
    const current = await lockGuidance(tx, projectItemId);
    if (!current) throw new NotFoundError(`Project agent guidance for project ${projectItemId} not found`);
    const version = await projectAgentGuidanceVersionStore.next(tx, projectItemId, current.updated_at);
    const result = await tx.query<ProjectAgentGuidanceRow>(
      `UPDATE project_agent_guidance SET owner_user_id = $2, updated_at = $3
       WHERE project_item_id = $1
       RETURNING project_item_id, owner_user_id, markdown, updated_at`,
      [projectItemId, newOwnerUserId, version],
    );
    if (result.rowCount === 0) {
      throw new NotFoundError(`Project agent guidance for project ${projectItemId} not found`);
    }
    return mapRow(requireSingleRow(result.rows, "project_agent_guidance transfer"));
  },
};

/**
 * Concrete `PoolClient` implementation of `@semprec/shared`'s `GuidanceReferenceStore`.
 * `requireProjectsItem` resolves the system Projects database by its canonical module id and
 * looks the item up in that database's partition — the only way to validate a partitioned
 * item id against a specific logical database, since `items` has no direct FK target.
 */
export const guidanceReferenceStore: GuidanceReferenceStore<PoolClient> = {
  async requireProjectsItem(tx, projectItemId) {
    const database = await getDatabaseByModuleId(tx, PROJECTS_MODULE_ID);
    // A missing Projects module database is a seeding/infrastructure problem, not a missing
    // item — throw a plain error (not `GuidanceReferenceNotFoundError`) so it propagates as an
    // infrastructure failure instead of being reported to the caller as a 400 "item not found".
    if (!database) {
      throw new Error(`Projects module database not found for module ${PROJECTS_MODULE_ID}`);
    }
    const item = await getItemById(tx, database.id, projectItemId);
    if (!item) {
      throw new GuidanceReferenceNotFoundError(`Project item ${projectItemId} not found in the Projects database`);
    }
  },

  async requireUser(tx, userId) {
    await requireTenantUser(tx, userId);
  },

  async requireUserLocale(tx, userId) {
    return (await requireTenantUser(tx, userId)).locale;
  },
};

/**
 * Resolves `userId` only when it is the current tenant's user (`getTenantUserId`). Another tenant's
 * user, a user bound to no tenant and an unknown id all fail the same way, so a caller can never
 * name a user outside the tenant as guidance owner or drift recipient.
 */
async function requireTenantUser(tx: PoolClient, userId: string) {
  const user = await getUserById(tx, userId);
  if (!user || (await getTenantUserId(tx)) !== userId) {
    throw new GuidanceReferenceNotFoundError(`User ${userId} not found`);
  }
  return user;
}

/**
 * Concrete `TransactionRunner<PoolClient>`: delegates to `withTransaction` (`db/pool.ts`) at the
 * requested isolation level, so after-commit hooks registered by stores inside the runner (e.g.
 * `runAfterCommit` calls made by `writeNotification`) fire after the commit, exactly as they
 * would for any other `withTransaction` caller.
 */
export function createPoolClientTransactionRunner(pool: Pool): TransactionRunner<PoolClient> {
  return {
    withTransaction: (options, work) => withTransaction(pool, work, { isolation: options.isolation }),
  };
}
