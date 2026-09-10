import type { Pool, PoolClient } from "pg";
import { GuidanceReferenceNotFoundError } from "@semprec/shared";
import type {
  GuidanceReferenceStore,
  ProjectAgentGuidance,
  ProjectAgentGuidanceStore,
  TransactionRunner,
} from "@semprec/shared";
import { requireSingleRow } from "./db/pool.js";
import { NotFoundError } from "./errors.js";
import { getDatabaseByModuleId } from "./chokePoint/databasesStore.js";
import { getItemById } from "./chokePoint/itemsStore.js";
import { getUserById } from "./auth/usersStore.js";
import { PROJECTS_MODULE_ID } from "./seed/tenDatabaseKeys.js";

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

/** Concrete `PoolClient` implementation of `@semprec/shared`'s `ProjectAgentGuidanceStore`. */
export const projectAgentGuidanceStore: ProjectAgentGuidanceStore<PoolClient> = {
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
    const { rows } = await tx.query<ProjectAgentGuidanceRow>(
      `INSERT INTO project_agent_guidance (project_item_id, owner_user_id, markdown, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (project_item_id)
       DO UPDATE SET markdown = EXCLUDED.markdown, updated_at = now()
       RETURNING project_item_id, owner_user_id, markdown, updated_at`,
      [row.projectItemId, row.ownerUserId, row.markdown],
    );
    return mapRow(requireSingleRow(rows, "project_agent_guidance upsert"));
  },

  async transfer(tx, projectItemId, currentOwnerUserId, newOwnerUserId) {
    // `owner_user_id = $2` in the WHERE clause mirrors `upsert`'s owner-mutation containment: a
    // direct call with a stale or wrong `currentOwnerUserId` matches no row and is rejected,
    // rather than silently transferring a guidance row it doesn't actually own.
    const { rows } = await tx.query<ProjectAgentGuidanceRow>(
      `UPDATE project_agent_guidance SET owner_user_id = $3, updated_at = now()
       WHERE project_item_id = $1 AND owner_user_id = $2
       RETURNING project_item_id, owner_user_id, markdown, updated_at`,
      [projectItemId, currentOwnerUserId, newOwnerUserId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundError(
        `Project agent guidance for project ${projectItemId} owned by ${currentOwnerUserId} not found`,
      );
    }
    return mapRow(row);
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
    const user = await getUserById(tx, userId);
    if (!user) throw new GuidanceReferenceNotFoundError(`User ${userId} not found`);
  },

  async requireUserLocale(tx, userId) {
    const user = await getUserById(tx, userId);
    if (!user) throw new GuidanceReferenceNotFoundError(`User ${userId} not found`);
    return user.locale;
  },
};

/**
 * Concrete `TransactionRunner<PoolClient>`: opens a dedicated connection at the requested
 * isolation level, commits on success, and always rolls back and releases on throw.
 */
export function createPoolClientTransactionRunner(pool: Pool): TransactionRunner<PoolClient> {
  return {
    async withTransaction(options, work) {
      const client = await pool.connect();
      try {
        const isolationClause = options.isolation === "serializable" ? "SERIALIZABLE" : "REPEATABLE READ";
        await client.query(`BEGIN ISOLATION LEVEL ${isolationClause}`);
        try {
          const result = await work(client);
          await client.query("COMMIT");
          return result;
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The original error is the one worth propagating; a failed rollback (e.g. a
            // broken connection) shouldn't mask it.
          }
          throw err;
        }
      } finally {
        client.release();
      }
    },
  };
}
