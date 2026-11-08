import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";

const projectRow = z.object({ id: z.uuid(), name: z.string() });

/**
 * The tenant's live (not deleted) projects whose permission manifest grants
 * `capabilities.email.send.autonomous`, ordered by name, then id (issue #1635). The grant is decided
 * by `generatePermissionManifest` itself, the same computation an agent run and the send choke point
 * read, so this list cannot disagree with what is enforced. Read only: nothing here writes the
 * project property behind the grant. Must run inside the caller's tenant transaction.
 */
export async function listAutonomousSendProjects(client: PoolClient): Promise<{ projectId: string; name: string }[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT i.id, COALESCE(i.properties->>'name', '') AS name
       FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
      WHERE i.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = 'projects'
        AND i.deleted_at IS NULL
      ORDER BY name, i.id`,
  );
  const allowed: { projectId: string; name: string }[] = [];
  for (const project of z.array(projectRow).parse(rows)) {
    const manifest = await generatePermissionManifest(client, project.id);
    if (manifest.capabilities.email.send.autonomous) allowed.push({ projectId: project.id, name: project.name });
  }
  return allowed;
}

/** `GET /api/mail/autonomous-send-projects` (issue #1635): the read-only list of projects allowed to send mail without confirmation. */
export function createMailAutonomousSendProjectsRouteHandler(pool: Pool) {
  return async () => ({
    status: 200,
    body: await withTransaction(pool, (client) => listAutonomousSendProjects(client)),
  });
}
