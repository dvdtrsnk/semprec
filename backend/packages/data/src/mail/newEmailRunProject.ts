// The project a `newEmail` run starts in: the thread's project when it has one, else the heartbeat's.
import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getMailMessageMetaByItemId, resolveMergedThreadId } from "./mailMessageMetaStore.js";

/**
 * Follows a merged-away thread to its target; any missing link or a trashed project gives the default.
 * Writes nothing. Mail agent tools are granted only to a project owning the mail databases, so a run in a
 * thread's ordinary project has no `mail.*` tool and prepares no draft.
 */
export async function resolveMailThreadRunProject(
  pool: Pool,
  input: { itemId: string; defaultProjectItemId: string },
): Promise<string> {
  const projectId = await withTransaction(
    pool,
    async (client) => {
      const meta = await getMailMessageMetaByItemId(client, input.itemId);
      const threadId = meta?.threadId ? await resolveMergedThreadId(client, meta.threadId) : null;
      if (threadId === null) return null;
      const { rows } = await client.query<{ item_id: string | null }>(
        "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
        [threadId],
      );
      const threadItemId = rows[0]?.item_id ?? null;
      if (threadItemId === null) return null;
      const [threads, projects] = await Promise.all([
        getDatabaseByModuleId(client, THREADS_MODULE_ID),
        getDatabaseByModuleId(client, PROJECTS_MODULE_ID),
      ]);
      if (!threads || !projects) throw new Error("The Threads and Projects databases are not seeded");
      const property = await getPropertyByKey(client, threads.id, "project");
      const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
      if (!definition) throw new Error("Threads.project is not seeded as a relation");
      const edges = await listRelationsForItem(client, definition.id, threadItemId);
      const candidates = await getItemsByIds(
        client,
        edges.map((edge) => otherSide(edge, threadItemId)),
      );
      return (
        candidates
          .filter((item) => item.databaseId === projects.id && item.deletedAt === null)
          .map((item) => item.id)
          .sort()[0] ?? null
      );
    },
    { isolation: "repeatable_read" },
  );
  return projectId ?? input.defaultProjectItemId;
}
