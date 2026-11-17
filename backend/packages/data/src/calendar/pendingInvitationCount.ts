import { requireSingleRow, type Queryable } from "../db/pool.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";

/** RLS confines the count to the client's tenant scope. Feeds `pendingInvites` of `GET /api/badge-counts`. */
export async function countPendingInvitations(client: Queryable): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM items i
       JOIN databases d ON d.id = i.database_id
      WHERE d.owner_module_id = $1 AND d.system
        AND i.deleted_at IS NULL
        AND i.properties->>'status' = 'pending'`,
    [INVITATIONS_MODULE_ID],
  );
  return Number(requireSingleRow(rows, "pending invitations count").count);
}
