import type { Queryable } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { parseAgentDatabaseAccess, type AgentDatabaseAccess } from "./agentDatabaseGrantsStore.js";

// User-only writes of `agent_database_grants`. Deliberately not exported from `index.ts`: `agent-runtime` depends on
// `@semprec/data`, so keeping them off the public surface keeps them unreachable from agent code.

export interface SetAgentDatabaseGrantInput {
  projectItemId: string;
  databaseId: string;
  access: AgentDatabaseAccess;
}

interface AgentDatabaseGrantAccessRow {
  access: string;
}

/**
 * Upserts the decision. The database is resolved through RLS first, so a foreign or missing database is a 404
 * rather than a composite-FK violation. Updating a row waits for transactions that hold it `FOR SHARE`.
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

/** Returns whether a row existed; removing a never-made decision is not an error. */
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
