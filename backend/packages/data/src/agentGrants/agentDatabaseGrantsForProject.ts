import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  defaultAgentDatabaseAccess,
  listProjectDatabaseAccess,
  type ProjectDatabaseAccessRow,
} from "./agentDatabaseAccess.js";
import { removeAgentDatabaseGrant, setAgentDatabaseGrant } from "./agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "./agentDatabaseGrantsStore.js";

// The project-level view of `agent_database_grants` for the Semp settings of a project (issue #1841): the list
// the client shows and the one write behind its toggle. The write is the only path from a route handler to
// `agentDatabaseGrantsAdminStore.ts`'s user-only mutations, as `mcp/mcpAgentPageGrants.ts` is for MCP tool
// grants; `index.ts` exports the wrapper and not the store.

interface ProjectLiveRow {
  live: boolean;
}

/**
 * Throws a `NotFoundError` unless `projectItemId` is a live item of the Projects database in the caller's
 * tenant (another tenant's item is invisible under row-level security). A trashed project, an unknown id and
 * an item of another database fail alike. `lock` is `" FOR SHARE"` for a write: the project's row then stays
 * as it is until the transaction ends, so a trash of the project (which updates the row) waits for the write.
 * The argument is a constant of this module, never a value.
 */
async function requireLiveProject(client: PoolClient, projectItemId: string, lock: "" | " FOR SHARE"): Promise<void> {
  const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  if (!projects) throw new Error("The Projects system database does not exist");
  const { rows } = await client.query<ProjectLiveRow>(
    `SELECT deleted_at IS NULL AS live FROM items WHERE database_id = $1 AND id = $2${lock}`,
    [projects.id, projectItemId],
  );
  if (!rows[0]?.live) throw new NotFoundError("Project not found");
}

/** Every database a grant can matter for, with the project's current access; a missing or trashed project is a 404. */
export async function listAgentDatabaseGrantsForProject(
  client: PoolClient,
  projectItemId: string,
): Promise<ProjectDatabaseAccessRow[]> {
  await requireLiveProject(client, projectItemId, "");
  return listProjectDatabaseAccess(client, projectItemId);
}

export interface SetAgentDatabaseGrantForProjectInput {
  projectItemId: string;
  databaseId: string;
  access: AgentDatabaseAccess;
}

interface DatabaseIdentityRow {
  id: string;
  key: string | null;
  name: string | null;
  system: boolean;
  sensitive: boolean;
}

/**
 * Sets what one project's agent may do with one database, in the caller's transaction, and returns the
 * database as the list shows it. The access that is the database's default (`none` for a sensitive database,
 * `write` for a user-created one) removes the stored decision; any other value is stored. The project and the
 * database rows are locked `FOR SHARE` for the transaction, so neither can be trashed or removed between the
 * checks and the write.
 *
 * Throws a `NotFoundError` for a missing or trashed project and for a missing database (another tenant's
 * database is missing), and a `ValidationError` for a non-sensitive system database: it is always open, so a
 * decision for it would never apply.
 *
 * This is the user-only write; see this file's header for why it is the only exported path to the store.
 */
export async function setAgentDatabaseGrantForProjectSettings(
  client: PoolClient,
  input: SetAgentDatabaseGrantForProjectInput,
): Promise<ProjectDatabaseAccessRow> {
  await requireLiveProject(client, input.projectItemId, " FOR SHARE");
  const { rows } = await client.query<DatabaseIdentityRow>(
    "SELECT id, key, name, system, sensitive FROM databases WHERE id = $1 FOR SHARE",
    [input.databaseId],
  );
  const database = rows[0];
  if (!database) {
    throw new NotFoundError(`Database ${input.databaseId} not found`, { resource: "database" });
  }
  if (database.system && !database.sensitive) {
    throw new ValidationError("The agent's access to this database cannot be changed: it is always open", {
      field: "databaseId",
    });
  }
  // Removing a decision that was never made is fine: the default applies either way.
  let access: AgentDatabaseAccess;
  if (input.access === defaultAgentDatabaseAccess(database)) {
    await removeAgentDatabaseGrant(client, input.projectItemId, input.databaseId);
    access = input.access;
  } else {
    access = await setAgentDatabaseGrant(client, input);
  }
  return {
    databaseId: database.id,
    key: database.key,
    name: database.name,
    sensitive: database.sensitive,
    system: database.system,
    access,
  };
}
