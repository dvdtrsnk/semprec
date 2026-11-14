// The project a `newEmail` run starts in (issue gh-1941): the project of the new message's thread when the thread has
// one, else the project of the heartbeat that fired. `core.agentRun` reads it from the heartbeat's `runProject` config
// (`{ resolver: "mailThreadProject" }`, resolved in `scheduler/actions.ts`).
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
 * The id of the project the run for the new message `itemId` starts in: the live project that the message's thread
 * holds in `Threads.project` (the thread it was merged into, for a merged-away one), else `defaultProjectItemId`. A
 * message without a `mail_message_meta` row or a thread, a thread without a Threads item or without a project, and a
 * project in the Trash all give the default. Nothing is written. It runs in the caller's tenant scope.
 *
 * The run belongs to that project and so holds that project's tools. The mail agent tools are granted to a project that
 * owns the mail databases (`generatePermissionManifest`), so a run in a thread's ordinary project has no `mail.*` tool and
 * prepares no draft, and writes no error, until a project can be granted a database it does not own (issue #1810). The
 * issue's decision ("The run starts in the thread's project when the thread has one") is kept as it is; the consequence
 * is recorded in docs/adr/2026-11-14-a-heartbeat-agent-run-takes-composition-root-dependencies-and-may-run-in-the-project-of-its-item.md.
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
