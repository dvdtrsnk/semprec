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

// The project-level view of `agent_database_grants` for a project's Semp settings. The write is the only path from a
// route handler to the user-only mutations of `agentDatabaseGrantsAdminStore.ts`; `index.ts` exports this wrapper,
// not the store.

interface ProjectLiveRow {
  live: boolean;
}

/**
 * Throws `NotFoundError` unless the id is a live Projects item in the caller's tenant. `" FOR SHARE"` (a module
 * constant) for a write, so a trash of the project waits for the write.
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

/** A missing or trashed project is a 404. */
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
 * Sets one project's access to one database and returns the row as the list shows it. The default access removes
 * the stored decision instead of storing it. Project and database rows are locked `FOR SHARE` so neither can be
 * trashed between the checks and the write. A non-sensitive system database is always open, so a decision for it
 * is a `ValidationError`.
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
