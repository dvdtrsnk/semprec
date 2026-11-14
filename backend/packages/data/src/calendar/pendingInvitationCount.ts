import { requireSingleRow, type Queryable } from "../db/pool.js";
import { INVITATIONS_MODULE_ID } from "../seed/invitationsKeys.js";

/**
 * The number of live invitations (issue gh-1954) whose `status` is `pending`, read on `client` in the tenant scope
 * it runs in; another tenant's invitations are not visible to the scope and so are not counted. A trashed invitation
 * is not live. A tenant without an Invitations database has none, so the count is `0`. It is the `pendingInvites` of
 * `GET /api/badge-counts` and of the app icon badge.
 */
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
