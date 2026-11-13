import type { Queryable } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { parseAgentDatabaseAccess, type AgentDatabaseAccess } from "./agentDatabaseGrantsStore.js";

// The user-only writes of `agent_database_grants` (issue #1810), the counterpart of
// `mcp/mcpGrantsAdminStore.ts`. This module is deliberately not exported from this package's
// `index.ts`: `agent-runtime` depends on `@semprec/data`, so keeping the writes off the public surface is
// what makes them unreachable from agent code. The routes that call them are issue #1841's, through `agentDatabaseGrantsForProject.ts`.

export interface SetAgentDatabaseGrantInput {
  projectItemId: string;
  databaseId: string;
  access: AgentDatabaseAccess;
}

interface AgentDatabaseGrantAccessRow {
  access: string;
}

/**
 * Stores the user's decision for one project and database, replacing an earlier one. The statement
 * resolves the database through row-level security before it inserts, so another tenant's (or a missing)
 * database is a not-found (404) instead of the foreign-key violation the table's composite tenant foreign
 * key would raise for it. A revoke that updates an existing row waits
 * for every transaction that checked that row (`assertAgentDatabaseAccess` holds it `FOR SHARE`).
 */
export async function setAgentDatabaseGrant(
  client: Queryable,
  input: SetAgentDatabaseGrantInput,
): Promise<AgentDatabaseAccess> {
  const { rows } = await client.query<AgentDatabaseGrantAccessRow>(
    `INSERT INTO agent_database_grants (project_item_id, database_id, access)
       SELECT $1, id, $3 FROM databases WHERE id = $2
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE
         SET access = EXCLUDED.access, updated_at = now()
       RETURNING access`,
    [input.projectItemId, input.databaseId, input.access],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`Database ${input.databaseId} not found`, { resource: "database" });
  return parseAgentDatabaseAccess(row.access);
}

/**
 * Removes the user's decision, so the default of the database applies again. Returns whether a row
 * existed: removing a decision that was never made is not an error.
 */
export async function removeAgentDatabaseGrant(
  client: Queryable,
  projectItemId: string,
  databaseId: string,
): Promise<boolean> {
  const result = await client.query(
    "DELETE FROM agent_database_grants WHERE project_item_id = $1 AND database_id = $2",
    [projectItemId, databaseId],
  );
  return (result.rowCount ?? 0) > 0;
}
