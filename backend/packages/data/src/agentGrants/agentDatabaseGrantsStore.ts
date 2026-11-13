import type { Queryable } from "../db/pool.js";

// The read side of `agent_database_grants` (issue #1810), and the cleanup of a purged project: what one
// project's agent may do with one database when the user has decided so explicitly. The decision itself, including what an absent row
// means, is `agentDatabaseAccess.ts`. The writes that grant, change or revoke access are in
// `agentDatabaseGrantsAdminStore.ts`, which is deliberately not exported from this package's `index.ts`,
// so agent code cannot reach them (docs/adr/2026-11-12-per-database-agent-grants.md).

const AGENT_DATABASE_ACCESS_VALUES = ["none", "read", "write"] as const;
export type AgentDatabaseAccess = (typeof AGENT_DATABASE_ACCESS_VALUES)[number];

function isAgentDatabaseAccess(value: unknown): value is AgentDatabaseAccess {
  return AGENT_DATABASE_ACCESS_VALUES.some((access) => access === value);
}

/** The access a stored row grants, or a failure when the column holds a value its CHECK constraint forbids. */
export function parseAgentDatabaseAccess(value: unknown): AgentDatabaseAccess {
  if (!isAgentDatabaseAccess(value)) throw new Error("agent_database_grants holds an unknown access value");
  return value;
}

interface AgentDatabaseGrantAccessRow {
  access: string;
}

/**
 * The stored access of one project for one database, or `null` when the user made no decision (the
 * default for that database then applies, see `agentDatabaseAccess.ts`). A plain read: the check
 * that guards a read or write locks the row itself, in the one statement that also reads the database.
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

/**
 * Deletes every decision of one project, the cleanup of the permanent purge of a Projects item
 * (`deleteItemDependents`). Zero rows is the normal outcome for a project the user never configured.
 */
export async function deleteAgentDatabaseGrantsForProject(client: Queryable, projectItemId: string): Promise<number> {
  const result = await client.query("DELETE FROM agent_database_grants WHERE project_item_id = $1", [projectItemId]);
  return result.rowCount ?? 0;
}
