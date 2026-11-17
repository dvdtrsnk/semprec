import type { Queryable } from "../db/pool.js";

// Read side of `agent_database_grants` and the purge cleanup. The access decision (including a missing row) is in
// `agentDatabaseAccess.ts`; writes are in `agentDatabaseGrantsAdminStore.ts`, kept off `index.ts` so agent code
// cannot reach them.

const AGENT_DATABASE_ACCESS_VALUES = ["none", "read", "write"] as const;
export type AgentDatabaseAccess = (typeof AGENT_DATABASE_ACCESS_VALUES)[number];

function isAgentDatabaseAccess(value: unknown): value is AgentDatabaseAccess {
  return AGENT_DATABASE_ACCESS_VALUES.some((access) => access === value);
}

/** Throws when the column holds a value its CHECK constraint forbids. */
export function parseAgentDatabaseAccess(value: unknown): AgentDatabaseAccess {
  if (!isAgentDatabaseAccess(value)) throw new Error("agent_database_grants holds an unknown access value");
  return value;
}

interface AgentDatabaseGrantAccessRow {
  access: string;
}

/**
 * `null` when no decision is stored. Unlocked: the access check locks the row itself.
 */
export async function getAccess(
  client: Queryable,
  projectItemId: string,
  databaseId: string,
): Promise<AgentDatabaseAccess | null> {
  const { rows } = await client.query<AgentDatabaseGrantAccessRow>(
    "SELECT access FROM agent_database_grants WHERE project_item_id = $1 AND database_id = $2",
    [projectItemId, databaseId],
  );
  return rows[0] ? parseAgentDatabaseAccess(rows[0].access) : null;
}

/** Cleanup of a Projects item's permanent purge (`deleteItemDependents`). */
export async function deleteAgentDatabaseGrantsForProject(client: Queryable, projectItemId: string): Promise<number> {
  const result = await client.query("DELETE FROM agent_database_grants WHERE project_item_id = $1", [projectItemId]);
  return result.rowCount ?? 0;
}
